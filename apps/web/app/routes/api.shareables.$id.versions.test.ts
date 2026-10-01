import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { seedWorkspace, seedUser } from '~/test/db-seed-fixture'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const publishMock = vi.hoisted(() => vi.fn())
const publishPrincipalMock = vi.hoisted(() => vi.fn())
const beginStaticSiteBundleVersionUploadSessionMock = vi.hoisted(() => vi.fn())
const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const ctxContextMock = vi.hoisted(() => Symbol('ctxContext'))
const waitUntilMock = vi.hoisted(() => vi.fn())
const checkUploadAccessMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const versionNumberLookupMock = vi.hoisted(() => vi.fn())
const visibilityRef = vi.hoisted(() => ({
  current: 'private' as 'private' | 'link',
}))

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  publicationChannel: () => 'api',
  ctxContext: ctxContextMock,
  getCliAuthority: () => null,
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
}))
vi.mock('~/services/shareables.server', () => ({
  beginStaticSiteBundleVersionUploadSession:
    beginStaticSiteBundleVersionUploadSessionMock,
}))
vi.mock('~/modules/publish', () => ({
  publish: publishMock,
  publishPrincipal: publishPrincipalMock,
}))
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: checkUploadAccessMock,
}))
vi.mock('~/lib/upload-permission-response.server', () => ({
  uploadPermissionFailureResponse: () =>
    Response.json(
      {
        error: {
          code: 'self-upload-disabled',
          message: 'Sign in with Google or Microsoft to upload files.',
        },
      },
      { status: 403 },
    ),
}))

import { action, middleware } from './api.shareables.$id.versions'

function actionArgs(form: FormData) {
  return actionArgsFor(
    'https://artifactshare.test/api/shareables/s1/versions',
    form,
  )
}

function actionArgsFor(url: string, form: FormData, id = 's1') {
  return {
    request: new Request(url, {
      method: 'POST',
      body: form,
    }),
    context: new Map([[ctxContextMock, { waitUntil: waitUntilMock }]]),
    params: { id },
  } as never
}

async function json(response: Response) {
  return await response.json()
}

describe('/api/shareables/:id/versions', () => {
  beforeEach(() => {
    publishMock.mockReset()
    publishPrincipalMock.mockReset().mockReturnValue({
      kind: 'human',
      user: {
        id: 'u1',
        kind: 'human',
        email: 'owner@example.com',
        workspaceId: 'ws1',
      },
    })
    beginStaticSiteBundleVersionUploadSessionMock.mockReset()
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    waitUntilMock.mockReset()
    checkUploadAccessMock.mockReset()
    visibilityRef.current = 'private'
    versionNumberLookupMock.mockReset().mockResolvedValue({ ordinal: 2 })
    createDbMock.mockReset().mockReturnValue({
      mocked: true,
      selectFrom: (table: string) =>
        table === 'versions'
          ? {
              select() {
                return this
              },
              where() {
                return this
              },
              executeTakeFirst: versionNumberLookupMock,
            }
          : {
              select: () => ({
                where: () => ({
                  executeTakeFirstOrThrow: async () => ({
                    visibility: visibilityRef.current,
                  }),
                }),
              }),
            },
    })
    checkUploadAccessMock.mockResolvedValue({ kind: 'allowed' })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test.each([
    ['single-file', null],
    ['single-file', 'Revision'],
    ['static_site', null],
    ['static_site', 'Revision'],
  ])(
    'returns the published Viewer ordinal for %s with label %s',
    async (kind, label) => {
      const { db, sqlite } = createMigratedInMemoryDb()
      try {
        seedWorkspace(sqlite)
        seedUser(sqlite, 'u1')
        sqlite.exec(`
        INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, name, created_at, updated_at)
        VALUES ('c1', 'ws1', 'inbox', 'u1', 'Inbox', '2026-01-01', '2026-01-01');
        INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, current_version_id, created_at, updated_at, container_id)
        VALUES ('s1', 'ws1', 'u1', 'Report', 'html_page', 'private', 'v9', '2026-01-01', '2026-01-01', 'c1'),
               ('s2', 'ws1', 'u1', 'Other', 'html_page', 'private', null, '2026-01-01', '2026-01-01', 'c1');
      `)
        const insert = sqlite.prepare(`INSERT INTO versions
        (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
        VALUES (?, ?, 'html_page', ?, '/index.html', 'test/index.html', 1, 'test', 'u1', ?, ?)`)
        for (const [id, artifact, status, created, published] of [
          ['v0', 's1', 'published', '2026-01-01', '2026-01-01'],
          ['v1', 's1', 'published', '2026-01-02', '2026-01-02'],
          ['v2', 's1', 'published', '2026-01-02', '2026-01-02'],
          ['v3', 's1', 'published', '2026-01-02', '2026-01-02'],
          ['v9', 's1', 'published', '2026-01-03', '2026-01-03'],
          ['draft', 's1', 'uploading', '2026-01-01', null],
          ['failed', 's1', 'failed', '2026-01-01', '2026-01-01'],
          ['unpublished', 's1', 'published', '2026-01-01', null],
          ['other', 's2', 'published', '2026-01-01', '2026-01-01'],
        ])
          insert.run(id!, artifact!, status!, created!, published!)
        createDbMock.mockReturnValue(db)
        publishMock.mockResolvedValue({ kind: 'ok', versionId: 'v2' })
        const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
        beginStaticSiteBundleVersionUploadSessionMock.mockResolvedValue({
          kind: 'ok',
          session: {
            addFile,
            commitVersion: vi
              .fn()
              .mockResolvedValue({ kind: 'ok', id: 's1', versionId: 'v2' }),
            abort: vi.fn(),
            get fileCount() {
              return addFile.mock.calls.length
            },
          },
        })
        const form = new FormData()
        form.append('file', new File(['<p>Report</p>'], 'index.html'))
        const query = new URLSearchParams()
        if (kind === 'static_site') query.set('artifact_kind', kind)
        if (label) query.set('label', label)
        const response = await action(
          actionArgsFor(
            `https://artifactshare.test/api/shareables/s1/versions?${query}`,
            form,
          ),
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({
          id: 's1',
          versionId: 'v2',
          number: 3,
          label,
        })
      } finally {
        await db.destroy()
      }
    },
  )

  test.each([
    ['single-file', 'error'],
    ['single-file', 'missing-row'],
    ['static_site', 'error'],
    ['static_site', 'missing-row'],
  ])(
    'preserves committed %s success when the ordinal lookup returns %s',
    async (kind, failure) => {
      const result = { kind: 'ok', id: 's1', versionId: 'ver2' }
      publishMock.mockResolvedValue(result)
      const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
      const commitVersion = vi.fn().mockResolvedValue(result)
      const abort = vi.fn()
      beginStaticSiteBundleVersionUploadSessionMock.mockResolvedValue({
        kind: 'ok',
        session: {
          addFile,
          commitVersion,
          abort,
          get fileCount() {
            return addFile.mock.calls.length
          },
        },
      })
      versionNumberLookupMock.mockImplementation(async () => {
        if (failure === 'error') throw new Error('Ordinal lookup failed')
        return undefined
      })
      const form = new FormData()
      form.append('file', new File(['<p>replacement</p>'], 'index.html'))

      const response = await action(
        actionArgsFor(
          `https://artifactshare.test/api/shareables/s1/versions?artifact_kind=${kind}`,
          form,
        ),
      )

      expect(response.status).toBe(200)
      expect(await json(response)).toEqual({
        id: 's1',
        versionId: 'ver2',
        label: null,
        shareUrl: 'https://artifactshare.test/a/s1',
        ...(kind === 'static_site' ? { artifactKind: 'static_site' } : {}),
      })
      expect(versionNumberLookupMock).toHaveBeenCalledTimes(1)
      const committed = kind === 'static_site' ? commitVersion : publishMock
      expect(committed).toHaveBeenCalledTimes(1)
      expect(committed.mock.invocationCallOrder[0]).toBeLessThan(
        versionNumberLookupMock.mock.invocationCallOrder[0]!,
      )
      expect(abort).not.toHaveBeenCalled()
    },
  )

  test.each(['', 'static_site'])(
    'rejects invalid and repeated labels before upload for %s',
    async (kind) => {
      for (const query of [
        'label=',
        'label=++',
        'label=%0A',
        ...['\u200d', '\u200d \u200d', '\u034f', '\ufe0f', '\u115f'].map(
          (label) => `label=${encodeURIComponent(label)}`,
        ),
        `label=${'a'.repeat(81)}`,
        'label=one&label=two',
      ]) {
        const response = await action(
          actionArgsFor(
            `https://artifactshare.test/api/shareables/s1/versions?artifact_kind=${kind}&${query}`,
            new FormData(),
          ),
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({
          error: { code: 'validation-failed' },
        })
      }
      expect(publishMock).not.toHaveBeenCalled()
      expect(
        beginStaticSiteBundleVersionUploadSessionMock,
      ).not.toHaveBeenCalled()
      expect(checkUploadAccessMock).not.toHaveBeenCalled()
    },
  )

  test.each(['index.html', 'index.md'])(
    'normalizes labels before single-file publication for %s',
    async (filename) => {
      publishMock.mockResolvedValue({ kind: 'ok', versionId: 'v1' })
      const form = new FormData()
      form.append('file', new File(['# Report'], filename))
      const response = await action(
        actionArgsFor(
          `https://artifactshare.test/api/shareables/s1/versions?label=${encodeURIComponent(' Cafe\u0301  日本語 ')}`,
          form,
        ),
      )
      expect(response.status).toBe(200)
      expect(await json(response)).toEqual({
        id: 's1',
        versionId: 'v1',
        number: 2,
        label: 'Café  日本語',
        shareUrl: 'https://artifactshare.test/a/s1',
      })
      expect(publishMock).toHaveBeenCalledWith(
        expect.objectContaining({
          target: expect.objectContaining({ label: 'Café  日本語' }),
        }),
      )
    },
  )

  test('maps static_site replacement rejection to copy-forbidden', async () => {
    publishMock.mockResolvedValue({ kind: 'copy-forbidden' })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'copy-forbidden' },
    })
    expect(publishMock).toHaveBeenCalledTimes(1)
  })

  test('single-file replacement returns the new version id', async () => {
    publishMock.mockResolvedValue({ kind: 'ok', versionId: 'ver2' })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 's1',
      versionId: 'ver2',
      number: 2,
      label: null,
      shareUrl: 'https://artifactshare.test/a/s1',
    })
  })

  test('single-file replacement uses the first file when a later file entry is text', async () => {
    publishMock.mockResolvedValue({ kind: 'ok', versionId: 'ver2' })
    const form = new FormData()
    form.append('file', new File(['replacement'], 'index.html'))
    form.append('file', 'ignored')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    expect(publishMock).toHaveBeenCalledTimes(1)
    const file = publishMock.mock.calls[0]?.[0].content.bytes as File
    expect(file.name).toBe('index.html')
    expect(await file.text()).toBe('replacement')
  })

  test('single-file replacement preserves a link artifact URL', async () => {
    visibilityRef.current = 'link'
    publishMock.mockResolvedValue({ kind: 'ok', versionId: 'ver2' })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/abc123def4/versions',
        form,
        'abc123def4',
      ),
    )

    await expect(json(response)).resolves.toMatchObject({
      shareUrl: 'https://abc123def4.localhost:5173/',
    })
  })

  test('static-site replacement preserves a link artifact URL', async () => {
    visibilityRef.current = 'link'
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    beginStaticSiteBundleVersionUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commitVersion: vi.fn().mockResolvedValue({
          kind: 'ok',
          id: 'abc123def4',
          versionId: 'ver2',
        }),
        abort: vi.fn(),
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/abc123def4/versions?artifact_kind=static_site',
        form,
        'abc123def4',
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'abc123def4',
      versionId: 'ver2',
      number: 2,
      artifactKind: 'static_site',
      label: null,
      shareUrl: 'https://abc123def4.localhost:5173/',
    })
  })

  test('static_site hint streams files through a version upload session', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commitVersion = vi
      .fn()
      .mockResolvedValue({ kind: 'ok', id: 's1', versionId: 'ver1' })
    const abort = vi.fn()
    beginStaticSiteBundleVersionUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commitVersion,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>new</p>'], 'index.html'))
    form.append('file', new File(['body{}'], 'assets/site.css'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/s1/versions?artifact_kind=static_site&label=+Cafe%CC%81+',
        form,
      ),
    )

    expect(beginStaticSiteBundleVersionUploadSessionMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      's1',
      null,
      expect.objectContaining({ label: 'Café' }),
    )
    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 's1',
      versionId: 'ver1',
      number: 2,
      label: 'Café',
      artifactKind: 'static_site',
      shareUrl: 'https://artifactshare.test/a/s1',
    })
    expect(beginStaticSiteBundleVersionUploadSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({ mocked: true }),
      {
        id: 'u1',
        email: 'owner@example.com',
        workspaceId: 'ws1',
        hd: 'example.com',
      },
      's1',
      null,
      {
        waitUntil: expect.any(Function),
        label: 'Café',
        createdVia: 'api',
        force: false,
      },
    )
    const waitUntil =
      beginStaticSiteBundleVersionUploadSessionMock.mock.calls[0]?.[4].waitUntil
    const promise = Promise.resolve()
    waitUntil(promise)
    expect(waitUntilMock).toHaveBeenCalledWith(promise)
    expect(addFile).toHaveBeenCalledTimes(2)
    expect(commitVersion).toHaveBeenCalledTimes(1)
    expect(publishMock).not.toHaveBeenCalled()
    expect(abort).not.toHaveBeenCalled()
  })

  test('static_site hint maps validation errors and aborts staged files', async () => {
    const addFile = vi.fn().mockResolvedValue({
      kind: 'duplicate-path',
      path: '/index.html',
    })
    const commitVersion = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleVersionUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commitVersion,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>new</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/s1/versions?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'duplicate-path' },
    })
    expect(commitVersion).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('static_site hint aborts and rejects an empty upload', async () => {
    const addFile = vi.fn()
    const commitVersion = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleVersionUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commitVersion,
        abort,
        fileCount: 0,
      },
    })
    const form = new FormData()

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/s1/versions?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'missing-file' },
    })
    expect(addFile).not.toHaveBeenCalled()
    expect(commitVersion).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('static_site hint maps commit errors through the static-site response mapper', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commitVersion = vi.fn().mockResolvedValue({
      kind: 'quota-exceeded',
    })
    const abort = vi.fn()
    beginStaticSiteBundleVersionUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commitVersion,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>new</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/s1/versions?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(413)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'quota-exceeded' },
    })
    expect(commitVersion).toHaveBeenCalledTimes(1)
    expect(abort).not.toHaveBeenCalled()
  })

  test('static_site hint maps non-static targets to copy-forbidden', async () => {
    beginStaticSiteBundleVersionUploadSessionMock.mockResolvedValue({
      kind: 'copy-forbidden',
    })
    const form = new FormData()
    form.append('file', new File(['<p>new</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/s1/versions?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'copy-forbidden' },
    })
    expect(publishMock).not.toHaveBeenCalled()
  })

  test('maps revoked workspace access to workspace-access-revoked', async () => {
    publishMock.mockResolvedValue({ kind: 'workspace-access-revoked' })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'workspace-access-revoked' },
    })
    expect(publishMock).toHaveBeenCalledTimes(1)
  })

  test('rejects users without self-upload enabled before parsing the replacement body', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'self-upload-disabled' })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'self-upload-disabled' },
    })
    expect(publishMock).not.toHaveBeenCalled()
  })

  test('rejects malformed multipart files through the shared version contract', async () => {
    const form = new FormData()
    form.append('file', 'not-a-file')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'missing-file' },
    })
    expect(publishMock).not.toHaveBeenCalled()
  })
})
