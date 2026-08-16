import { beforeEach, describe, expect, test, vi } from 'vitest'

const uploadShareableMock = vi.hoisted(() => vi.fn())
const createVersionMock = vi.hoisted(() => vi.fn())
const resolveArtifactKeyMock = vi.hoisted(() => vi.fn())
const runStaticSiteVersionUploadMock = vi.hoisted(() => vi.fn())
const beginStaticSiteBundleUploadSessionMock = vi.hoisted(() => vi.fn())
const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const ctxContextMock = vi.hoisted(() => Symbol('ctxContext'))
const authSourceContextMock = vi.hoisted(() => Symbol('authSourceContext'))
const waitUntilMock = vi.hoisted(() => vi.fn())
const checkUploadAccessMock = vi.hoisted(() => vi.fn())
const resolveUploadContainerMock = vi.hoisted(() => vi.fn())
const recordFirstArtifactPostMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  ctxContext: ctxContextMock,
  authSourceContext: authSourceContextMock,
  getCliAuthority: () => null,
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => ({ mocked: true }),
}))
vi.mock('~/services/shareables.server', () => ({
  beginStaticSiteBundleUploadSession: beginStaticSiteBundleUploadSessionMock,
  createVersion: createVersionMock,
  uploadShareable: uploadShareableMock,
}))
vi.mock('~/services/artifact-keys.server', async () => {
  const actual = await vi.importActual<
    typeof import('~/services/artifact-keys.server')
  >('~/services/artifact-keys.server')
  return {
    normalizeArtifactKey: actual.normalizeArtifactKey,
    resolveArtifactKey: resolveArtifactKeyMock,
  }
})
vi.mock('~/lib/static-site-version-upload.server', () => ({
  runStaticSiteVersionUpload: runStaticSiteVersionUploadMock,
}))
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: checkUploadAccessMock,
}))
vi.mock('~/services/projects.server', () => ({
  resolveUploadContainer: resolveUploadContainerMock,
}))
vi.mock('~/services/first-post-analytics.server', () => ({
  recordFirstArtifactPost: recordFirstArtifactPostMock,
}))
vi.mock('~/lib/upload-permission-response.server', () => ({
  uploadPermissionFailureResponse: (permission: { kind: string }) =>
    permission.kind === 'not-allowed'
      ? Response.json(
          {
            error: {
              code: 'upload-not-allowed',
              message:
                'Uploads are temporarily unavailable. Contact Artifact Share support if you need help.',
            },
          },
          { status: 403 },
        )
      : Response.json(
          {
            error: {
              code: 'upload-policy-unavailable',
              message: 'Upload permission could not be checked. Try again.',
            },
          },
          { status: 503 },
        ),
}))

import { action, middleware } from './api.shareables.uploads'

function actionArgs(form: FormData) {
  return actionArgsFor(
    'https://artifactshare.test/api/shareables/uploads',
    form,
  )
}

function actionArgsFor(url: string, form: FormData) {
  return {
    request: new Request(url, {
      method: 'POST',
      body: form,
    }),
    context: new Map([[ctxContextMock, { waitUntil: waitUntilMock }]]),
  } as never
}

async function json(response: Response) {
  return await response.json()
}

describe('/api/shareables/uploads', () => {
  beforeEach(() => {
    uploadShareableMock.mockReset()
    createVersionMock.mockReset()
    resolveArtifactKeyMock.mockReset()
    runStaticSiteVersionUploadMock.mockReset()
    beginStaticSiteBundleUploadSessionMock.mockReset()
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    waitUntilMock.mockReset()
    checkUploadAccessMock.mockReset()
    checkUploadAccessMock.mockResolvedValue({ kind: 'allowed' })
    resolveUploadContainerMock.mockReset()
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'inbox-1',
      containerKind: 'inbox',
      workspaceId: 'ws1',
      isExternalPosting: false,
    })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('single-file upload path is unchanged when artifact_kind is absent', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
      link_expires_at: null,
      linkExpiresAt: null,
    })
    const form = new FormData()
    const file = new File(['<p>hello</p>'], 'hello.html', {
      type: 'text/html',
    })
    form.append('file', file)
    form.append('visibility', 'private')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
      link_expires_at: null,
      containerId: null,
      shareUrl: 'https://artifactshare.test/a/abc123def4',
    })
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    const uploadCall = uploadShareableMock.mock.calls[0]
    expect(uploadCall?.[0]).toEqual({ mocked: true })
    expect(uploadCall?.[1]).toEqual({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
    expect(uploadCall?.[2]).toMatchObject({
      name: file.name,
      size: file.size,
      type: file.type,
    })
    expect(uploadCall?.[3]).toBe('private')
    expect(uploadCall?.[4]).toEqual([])
    expect(uploadCall?.[5]).toBeNull()
    expect(checkUploadAccessMock).toHaveBeenCalledWith(expect.anything())
  })

  test('forwards slack_notify=false to uploadShareable options', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
      linkExpiresAt: null,
    })
    const form = new FormData()
    form.append('file', new File(['hi'], 'hi.html'))
    form.append('visibility', 'private')
    form.append('slack_notify', 'false')
    await action(actionArgs(form))
    expect(uploadShareableMock.mock.calls[0]?.[7]).toEqual({
      slackNotify: false,
    })
  })

  test('returns a localized warning when Slack enqueue is suppressed', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'project',
      linkExpiresAt: null,
      slackNotificationSuppressed: true,
    })
    const form = new FormData()
    form.append('file', new File(['hi'], 'hi.html'))
    form.append('visibility', 'project')
    form.append('container_id', 'project-a')

    const response = await action(actionArgs(form))
    await expect(json(response)).resolves.toMatchObject({
      warnings: [
        {
          code: 'slack_reauthorization_required',
          message: expect.stringContaining('Slack notifications'),
        },
      ],
    })
  })

  test('single-file upload forwards finite and unlimited link expiry', async () => {
    const finite = '2026-08-01T00:00:00.000Z'
    uploadShareableMock
      .mockResolvedValueOnce({
        kind: 'ok',
        id: 'finite-id',
        versionId: 'finite-version',
        artifactKind: 'html_page',
        visibility: 'link',
        linkExpiresAt: finite,
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        id: 'unlimited-id',
        versionId: 'unlimited-version',
        artifactKind: 'html_page',
        visibility: 'link',
        linkExpiresAt: null,
      })

    const finiteForm = new FormData()
    finiteForm.append('file', new File(['<p>finite</p>'], 'finite.html'))
    finiteForm.append('visibility', 'link')
    finiteForm.append('link_expires_at', finite)
    const finiteResponse = await action(actionArgs(finiteForm))
    await expect(json(finiteResponse)).resolves.toMatchObject({
      id: 'finite-id',
      link_expires_at: finite,
    })
    expect(uploadShareableMock.mock.calls[0]?.[7]).toEqual({
      linkExpiresAt: finite,
    })

    const unlimitedForm = new FormData()
    unlimitedForm.append(
      'file',
      new File(['<p>unlimited</p>'], 'unlimited.html'),
    )
    unlimitedForm.append('visibility', 'link')
    unlimitedForm.append('link_expires_at', 'null')
    const unlimitedResponse = await action(actionArgs(unlimitedForm))
    await expect(json(unlimitedResponse)).resolves.toMatchObject({
      id: 'unlimited-id',
    })
    expect(uploadShareableMock.mock.calls[1]?.[7]).toEqual({
      linkExpiresAt: null,
    })
  })

  test.each([
    'link-sharing-plan-required',
    'link-sharing-disabled',
    'link-expiry-invalid',
  ])(
    'single-file upload maps %s without changing the error code',
    async (kind) => {
      uploadShareableMock.mockResolvedValue({ kind })
      const form = new FormData()
      form.append('file', new File(['<p>link</p>'], 'link.html'))
      form.append('visibility', 'link')

      const response = await action(actionArgs(form))

      expect(response.status).toBe(
        kind === 'link-sharing-plan-required'
          ? 402
          : kind === 'link-sharing-disabled'
            ? 403
            : 400,
      )
      await expect(json(response)).resolves.toMatchObject({
        error: { code: kind },
      })
    },
  )

  test('single-file upload passes a project container id to the create call', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
    })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    form.append('container_id', 'project-a')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    expect(uploadShareableMock.mock.calls[0]?.[5]).toBe('project-a')
  })

  test('single-file upload passes initial grant emails to the create call', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
    })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    form.append('grant_email', 'A@example.com')
    form.append('grant_email', 'b@example.com')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    expect(uploadShareableMock.mock.calls[0]?.[4]).toEqual([
      'A@example.com',
      'b@example.com',
    ])
  })

  test('single-file upload lets the service normalize duplicate grant emails', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
    })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    for (let i = 0; i < 51; i += 1) {
      form.append('grant_email', 'viewer@example.com')
    }

    const response = await action(actionArgs(form))

    expect(response.status).toBe(200)
    expect(uploadShareableMock).toHaveBeenCalledTimes(1)
    expect(uploadShareableMock.mock.calls[0]?.[4]).toHaveLength(51)
  })

  test('single-file upload maps grant limit errors to invalid-grants', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'too-many-grants',
      limit: 50,
    })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    form.append('grant_email', 'viewer@example.com')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-grants' },
    })
  })

  test('single-file upload maps invalid container errors to invalid-container', async () => {
    uploadShareableMock.mockResolvedValue({ kind: 'invalid-container' })
    const form = new FormData()
    form.append('file', new File(['<p>hello</p>'], 'hello.html'))
    form.append('visibility', 'private')
    form.append('container_id', 'project-a')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-container' },
    })
  })

  test('rejects any artifact_kind on the single-file endpoint', async () => {
    const form = new FormData()
    form.append('artifact_kind', 'static_site')
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'unknown-artifact-kind' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('single-file upload maps the contributor guardrail to forbidden', async () => {
    uploadShareableMock.mockResolvedValue({
      kind: 'contributor-limit-exceeded',
    })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'contributor-limit-exceeded' },
    })
  })

  test('single-file upload maps revoked workspace access to forbidden response', async () => {
    uploadShareableMock.mockResolvedValue({ kind: 'workspace-access-revoked' })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'workspace-access-revoked' },
    })
  })

  test('single-file upload rejects users denied by Flagship after resolving the destination', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'not-allowed' })
    const form = new FormData()
    const file = new File(['x'], 'a.html', { type: 'text/html' })
    form.append('file', file)

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'upload-not-allowed' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('cross-workspace upload is rejected when upload-allowed denies', async () => {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    checkUploadAccessMock.mockResolvedValue({ kind: 'not-allowed' })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'upload-not-allowed' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('single-file upload maps an unresolved destination to invalid-container', async () => {
    resolveUploadContainerMock.mockResolvedValue({ kind: 'invalid-container' })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-container' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
    expect(checkUploadAccessMock).not.toHaveBeenCalled()
  })

  test('single-file upload rejects publish_key for a cross-workspace destination', async () => {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?publish_key=foo',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-key' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('static_site upload rejects publish_key for a cross-workspace destination', async () => {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    const form = new FormData()
    form.append('file', new File(['x'], 'index.html', { type: 'text/html' }))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&publish_key=foo',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-key' },
    })
    expect(resolveArtifactKeyMock).not.toHaveBeenCalled()
    expect(beginStaticSiteBundleUploadSessionMock).not.toHaveBeenCalled()
    expect(runStaticSiteVersionUploadMock).not.toHaveBeenCalled()
  })

  test('static_site upload forwards a cross-workspace destination to the upload session', async () => {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      linkExpiresAt: null,
    })
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort: vi.fn(),
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('visibility', 'private')
    form.append('container_id', 'project-b')
    form.append(
      'file',
      new File(['<p>hi</p>'], 'index.html', { type: 'text/html' }),
    )

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&container_id=project-b',
        form,
      ),
    )

    expect(response.status).toBe(200)
    expect(beginStaticSiteBundleUploadSessionMock).toHaveBeenCalledTimes(1)
    expect(beginStaticSiteBundleUploadSessionMock.mock.calls[0]?.[2]).toBe(
      'project-b',
    )
    expect(commit).toHaveBeenCalledWith('private', [], undefined)
  })

  function staticSiteSessionWithCommit(commitResult: unknown) {
    resolveUploadContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'project-b',
      containerKind: 'project',
      workspaceId: 'ws-b',
      isExternalPosting: true,
    })
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue(commitResult)
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort: vi.fn(),
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('visibility', 'private')
    form.append('container_id', 'project-b')
    form.append(
      'file',
      new File(['<p>hi</p>'], 'index.html', { type: 'text/html' }),
    )
    return action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&container_id=project-b',
        form,
      ),
    )
  }

  test('static_site upload records a first post only when the commit succeeds', async () => {
    recordFirstArtifactPostMock.mockClear()
    await staticSiteSessionWithCommit({ kind: 'missing-entrypoint' })
    // A failed commit posts nothing, so it must not claim the one-time row.
    expect(recordFirstArtifactPostMock).not.toHaveBeenCalled()

    recordFirstArtifactPostMock.mockClear()
    await staticSiteSessionWithCommit({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      linkExpiresAt: null,
    })
    expect(recordFirstArtifactPostMock).toHaveBeenCalledTimes(1)
  })

  test('static_site upload maps an unresolved destination to invalid-container', async () => {
    resolveUploadContainerMock.mockResolvedValue({ kind: 'invalid-container' })
    const form = new FormData()
    form.append('file', new File(['x'], 'index.html', { type: 'text/html' }))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-container' },
    })
    expect(checkUploadAccessMock).not.toHaveBeenCalled()
    expect(beginStaticSiteBundleUploadSessionMock).not.toHaveBeenCalled()
  })

  test('static_site upload rejects users denied by Flagship after resolving the destination', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'not-allowed' })
    const form = new FormData()
    form.append('file', new File(['x'], 'index.html', { type: 'text/html' }))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'upload-not-allowed' },
    })
    expect(beginStaticSiteBundleUploadSessionMock).not.toHaveBeenCalled()
  })

  test('single-file upload returns policy-unavailable when Flagship evaluation fails', async () => {
    checkUploadAccessMock.mockResolvedValue({
      kind: 'flagship-error',
      error: new Error('flagship unavailable'),
    })
    const form = new FormData()
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(503)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'upload-policy-unavailable' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('rejects File-typed artifact_kind with 400', async () => {
    const form = new FormData()
    form.append(
      'artifact_kind',
      new File(['unused'], 'oops', { type: 'application/octet-stream' }),
    )
    form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-artifact-kind' },
    })
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test.each(['public'])(
    'single-file upload rejects %s visibility as a new setting',
    async (visibility) => {
      const form = new FormData()
      form.append('file', new File(['x'], 'a.html', { type: 'text/html' }))
      form.append('visibility', visibility)

      const response = await action(actionArgs(form))

      expect(response.status).toBe(400)
      await expect(json(response)).resolves.toMatchObject({
        error: { code: 'invalid-visibility' },
      })
      expect(uploadShareableMock).not.toHaveBeenCalled()
    },
  )

  test.each(['public'])(
    'static_site upload rejects %s visibility as a new setting',
    async (visibility) => {
      const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
      const commit = vi.fn()
      const abort = vi.fn()
      beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
        kind: 'ok',
        session: {
          addFile,
          commit,
          abort,
          get fileCount() {
            return addFile.mock.calls.length
          },
        },
      })
      const form = new FormData()
      form.append('file', new File(['<p>hi</p>'], 'index.html'))
      form.append('visibility', visibility)

      const response = await action(
        actionArgsFor(
          'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
          form,
        ),
      )

      expect(response.status).toBe(400)
      await expect(json(response)).resolves.toMatchObject({
        error: { code: 'invalid-visibility' },
      })
      expect(commit).not.toHaveBeenCalled()
      expect(abort).toHaveBeenCalledTimes(1)
    },
  )

  test('static_site hint streams files through an upload session instead of keeping a File array', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
    })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    const index = new File(['<p>hi</p>'], 'index.html', {
      type: 'text/html',
    })
    const css = new File(['body{}'], 'style.css', { type: 'text/css' })
    form.append('visibility', 'private')
    form.append('file', index)
    form.append('file', css, 'assets/site.css')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'static_site',
      shareUrl: 'https://artifactshare.test/a/abc123def4',
    })
    expect(beginStaticSiteBundleUploadSessionMock).toHaveBeenCalledWith(
      { mocked: true },
      {
        id: 'u1',
        email: 'owner@example.com',
        workspaceId: 'ws1',
        hd: 'example.com',
      },
      null,
      null,
    )
    expect(addFile).toHaveBeenCalledTimes(2)
    expect(addFile.mock.calls[0]?.[0]).toMatchObject({ name: index.name })
    expect(addFile.mock.calls[1]?.[0]).toMatchObject({
      name: 'assets/site.css',
    })
    expect(commit).toHaveBeenCalledWith('private', [], undefined)
    expect(abort).not.toHaveBeenCalled()
  })

  test('static_site upload forwards finite and unlimited link expiry', async () => {
    const finite = '2026-08-01T00:00:00.000Z'
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi
      .fn()
      .mockResolvedValueOnce({
        kind: 'ok',
        id: 'finite-id',
        versionId: 'finite-version',
        visibility: 'link',
        linkExpiresAt: finite,
      })
      .mockResolvedValueOnce({
        kind: 'ok',
        id: 'unlimited-id',
        versionId: 'unlimited-version',
        visibility: 'link',
        linkExpiresAt: null,
      })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })

    const finiteForm = new FormData()
    finiteForm.append('visibility', 'link')
    finiteForm.append('link_expires_at', finite)
    finiteForm.append('file', new File(['<p>hi</p>'], 'index.html'))
    const finiteResponse = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        finiteForm,
      ),
    )
    await expect(json(finiteResponse)).resolves.toMatchObject({
      id: 'finite-id',
      link_expires_at: finite,
    })
    expect(commit.mock.calls[0]).toEqual(['link', [], finite])

    const unlimitedForm = new FormData()
    unlimitedForm.append('visibility', 'link')
    unlimitedForm.append('link_expires_at', 'null')
    unlimitedForm.append('file', new File(['<p>hi</p>'], 'index.html'))
    const unlimitedResponse = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        unlimitedForm,
      ),
    )
    await expect(json(unlimitedResponse)).resolves.toMatchObject({
      id: 'unlimited-id',
      link_expires_at: null,
    })
    expect(commit.mock.calls[1]).toEqual(['link', [], null])
  })

  test('static_site upload passes a project container id to the upload session', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
    })
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort: vi.fn(),
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('visibility', 'private')
    form.append('container_id', 'project-a')
    form.append('file', new File(['<p>hi</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&container_id=project-a',
        form,
      ),
    )

    expect(response.status).toBe(200)
    expect(beginStaticSiteBundleUploadSessionMock.mock.calls[0]?.[2]).toBe(
      'project-a',
    )
    expect(commit).toHaveBeenCalledWith('private', [], undefined)
  })

  test('static_site upload rejects mismatched query and form container ids', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('visibility', 'private')
    form.append('container_id', 'project-b')
    form.append('file', new File(['<p>hi</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&container_id=project-a',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-container' },
    })
    expect(commit).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('static_site upload passes initial grant emails to commit', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn().mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
    })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))
    form.append('visibility', 'private')
    form.append('grant_email', 'team@example.com')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(200)
    expect(commit).toHaveBeenCalledWith(
      'private',
      ['team@example.com'],
      undefined,
    )
    expect(abort).not.toHaveBeenCalled()
  })

  test('static_site upload maps grant limit errors to invalid-grants', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'too-many-grants', limit: 50 })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))
    form.append('visibility', 'private')
    form.append('grant_email', 'team@example.com')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-grants' },
    })
    expect(abort).not.toHaveBeenCalled()
  })

  test('static_site upload rejects file-valued grant emails and aborts uploaded files', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))
    form.append('grant_email', new File(['x'], 'grant.txt'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-grants' },
    })
    expect(commit).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('static_site upload maps the contributor guardrail to forbidden', async () => {
    const addFile = vi.fn().mockResolvedValue({ kind: 'ok' })
    const commit = vi
      .fn()
      .mockResolvedValue({ kind: 'contributor-limit-exceeded' })
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'contributor-limit-exceeded' },
    })
  })

  test('static_site upload rejects revoked workspace access before parsing files', async () => {
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'workspace-access-revoked',
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'workspace-access-revoked' },
    })
  })

  test('static_site hint maps session validation errors and aborts uploaded files', async () => {
    const addFile = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ok' })
      .mockResolvedValueOnce({
        kind: 'invalid-path',
        path: '../secret.txt',
        reason: 'Blocked path traversal: ../secret.txt',
      })
    const commit = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'index.html'))
    form.append('file', new File(['secret'], '../secret.txt'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: {
        code: 'invalid-path',
        message: expect.stringContaining('../secret.txt'),
      },
    })
    expect(commit).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('static_site hint maps duplicate paths to 400 and aborts uploaded files', async () => {
    const addFile = vi
      .fn()
      .mockResolvedValueOnce({ kind: 'ok' })
      .mockResolvedValueOnce({
        kind: 'duplicate-path',
        path: '/assets/café.html',
      })
    const commit = vi.fn()
    const abort = vi.fn()
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort,
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append('file', new File(['<p>hi</p>'], 'assets/cafe\u0301.html'))
    form.append('file', new File(['<p>bye</p>'], 'assets/café.html'))

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: {
        code: 'duplicate-path',
        message: expect.stringContaining('/assets/café.html'),
      },
    })
    expect(commit).not.toHaveBeenCalled()
    expect(abort).toHaveBeenCalledTimes(1)
  })

  test('publish_key that is blank after trimming fails with invalid-key', async () => {
    const form = new FormData()
    form.append('file', new File(['<p>x</p>'], 'x.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?publish_key=%20%20',
        form,
      ),
    )

    expect(response.status).toBe(400)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'invalid-key' },
    })
    expect(resolveArtifactKeyMock).not.toHaveBeenCalled()
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('publish_key create path passes the key to uploadShareable and reports created', async () => {
    resolveArtifactKeyMock.mockResolvedValue({
      kind: 'create',
      containerId: 'inbox-1',
    })
    uploadShareableMock.mockResolvedValue({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      artifactKind: 'html_page',
      visibility: 'private',
    })
    const form = new FormData()
    form.append('file', new File(['<p>x</p>'], 'x.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?publish_key=pr-482',
        form,
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toMatchObject({
      id: 'abc123def4',
      created: true,
    })
    expect(resolveArtifactKeyMock).toHaveBeenCalledWith(
      { mocked: true },
      expect.objectContaining({ id: 'u1' }),
      null,
      'pr-482',
      'single_file',
    )
    expect(uploadShareableMock.mock.calls[0]?.[6]).toBe('pr-482')
  })

  test('publish_key update path adds a version and reports created: false', async () => {
    resolveArtifactKeyMock.mockResolvedValue({
      kind: 'update',
      keyId: 'key-1',
      shareableId: 'abc123def4',
      artifactKind: 'html_page',
      visibility: 'project',
    })
    createVersionMock.mockResolvedValue({
      kind: 'ok',
      versionId: 'ver2',
      artifactKind: 'html_page',
    })
    const form = new FormData()
    form.append('file', new File(['<p>x</p>'], 'x.html', { type: 'text/html' }))
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?publish_key=pr-482',
        form,
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 'abc123def4',
      versionId: 'ver2',
      artifactKind: 'html_page',
      visibility: 'project',
      containerId: null,
      shareUrl: 'https://artifactshare.test/a/abc123def4',
      created: false,
    })
    expect(createVersionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shareableId: 'abc123def4',
        touchArtifactKeyId: 'key-1',
        waitUntil: expect.any(Function),
      }),
    )
    const waitUntil = createVersionMock.mock.calls[0]?.[0].waitUntil
    const promise = Promise.resolve()
    waitUntil(promise)
    expect(waitUntilMock).toHaveBeenCalledWith(promise)
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('publish_key resolution failures map to key error responses', async () => {
    for (const [kind, code, status] of [
      ['key-target-moved', 'key-target-moved', 409],
      ['key-kind-mismatch', 'key-kind-mismatch', 409],
      ['invalid-container', 'invalid-container', 400],
    ] as const) {
      resolveArtifactKeyMock.mockResolvedValue({ kind })
      const form = new FormData()
      form.append(
        'file',
        new File(['<p>x</p>'], 'x.html', { type: 'text/html' }),
      )
      form.append('visibility', 'private')

      const response = await action(
        actionArgsFor(
          'https://artifactshare.test/api/shareables/uploads?publish_key=pr-482',
          form,
        ),
      )

      expect(response.status).toBe(status)
      await expect(json(response)).resolves.toMatchObject({
        error: { code },
      })
    }
    expect(uploadShareableMock).not.toHaveBeenCalled()
  })

  test('publish_key static-site update path delegates to the version upload flow', async () => {
    resolveArtifactKeyMock.mockResolvedValue({
      kind: 'update',
      keyId: 'key-1',
      shareableId: 'abc123def4',
      artifactKind: 'static_site',
      visibility: 'project',
    })
    runStaticSiteVersionUploadMock.mockResolvedValue(
      Response.json({ id: 'abc123def4', created: false }),
    )
    const form = new FormData()
    form.append('visibility', 'project')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&publish_key=site-key',
        form,
      ),
    )

    expect(response.status).toBe(200)
    expect(resolveArtifactKeyMock).toHaveBeenCalledWith(
      { mocked: true },
      expect.objectContaining({ id: 'u1' }),
      null,
      'site-key',
      'static_site',
    )
    expect(runStaticSiteVersionUploadMock).toHaveBeenCalledWith(
      { mocked: true },
      expect.any(Request),
      expect.objectContaining({ id: 'u1' }),
      'abc123def4',
      {
        touchArtifactKeyId: 'key-1',
        extraOkFields: { visibility: 'project', created: false },
        waitUntil: expect.any(Function),
      },
    )
    const waitUntil =
      runStaticSiteVersionUploadMock.mock.calls[0]?.[4].waitUntil
    const promise = Promise.resolve()
    waitUntil(promise)
    expect(waitUntilMock).toHaveBeenCalledWith(promise)
    expect(beginStaticSiteBundleUploadSessionMock).not.toHaveBeenCalled()
  })

  test('publish_key static-site create path passes the key to the create session', async () => {
    resolveArtifactKeyMock.mockResolvedValue({
      kind: 'create',
      containerId: 'inbox-1',
    })
    const addFile = vi.fn(async () => ({ kind: 'ok' }))
    const commit = vi.fn(async () => ({
      kind: 'ok',
      id: 'abc123def4',
      versionId: 'ver1',
      visibility: 'private',
    }))
    beginStaticSiteBundleUploadSessionMock.mockResolvedValue({
      kind: 'ok',
      session: {
        addFile,
        commit,
        abort: vi.fn(),
        get fileCount() {
          return addFile.mock.calls.length
        },
      },
    })
    const form = new FormData()
    form.append(
      'file',
      new File(['<p>hi</p>'], 'index.html', { type: 'text/html' }),
    )
    form.append('visibility', 'private')

    const response = await action(
      actionArgsFor(
        'https://artifactshare.test/api/shareables/uploads?artifact_kind=static_site&publish_key=site-key',
        form,
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toMatchObject({
      id: 'abc123def4',
      created: true,
    })
    expect(beginStaticSiteBundleUploadSessionMock).toHaveBeenCalledWith(
      { mocked: true },
      expect.objectContaining({ id: 'u1' }),
      null,
      'site-key',
    )
  })
})
