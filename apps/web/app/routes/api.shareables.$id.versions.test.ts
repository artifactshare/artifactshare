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
    createDbMock.mockReset().mockReturnValue({
      mocked: true,
      selectFrom: () => ({
        select: () => ({
          where: () => ({
            executeTakeFirstOrThrow: async () => ({
              visibility: visibilityRef.current,
            }),
          }),
        }),
      }),
    })
    checkUploadAccessMock.mockResolvedValue({ kind: 'allowed' })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

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

    await expect(json(response)).resolves.toMatchObject({
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
      { waitUntil: expect.any(Function), label: 'Café' },
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
