import { beforeEach, describe, expect, test, vi } from 'vitest'

const updateShareableMock = vi.hoisted(() => vi.fn())
const beginStaticSiteBundleVersionUploadSessionMock = vi.hoisted(() => vi.fn())
const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const ctxContextMock = vi.hoisted(() => Symbol('ctxContext'))
const waitUntilMock = vi.hoisted(() => vi.fn())
const checkUploadAccessMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  ctxContext: ctxContextMock,
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => ({ mocked: true }),
}))
vi.mock('~/services/shareables.server', () => ({
  beginStaticSiteBundleVersionUploadSession:
    beginStaticSiteBundleVersionUploadSessionMock,
  updateShareable: updateShareableMock,
}))
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: checkUploadAccessMock,
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

import { action, middleware } from './api.shareables.$id.versions'

function actionArgs(form: FormData) {
  return actionArgsFor(
    'https://artifactshare.test/api/shareables/s1/versions',
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
    params: { id: 's1' },
  } as never
}

async function json(response: Response) {
  return await response.json()
}

describe('/api/shareables/:id/versions', () => {
  beforeEach(() => {
    updateShareableMock.mockReset()
    beginStaticSiteBundleVersionUploadSessionMock.mockReset()
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    waitUntilMock.mockReset()
    checkUploadAccessMock.mockReset()
    checkUploadAccessMock.mockResolvedValue({ kind: 'allowed' })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('maps static_site replacement rejection to copy-forbidden', async () => {
    updateShareableMock.mockResolvedValue({ kind: 'copy-forbidden' })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'copy-forbidden' },
    })
    expect(updateShareableMock).toHaveBeenCalledTimes(1)
  })

  test('single-file replacement returns the new version id', async () => {
    updateShareableMock.mockResolvedValue({ kind: 'ok', versionId: 'ver2' })
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
        'https://artifactshare.test/api/shareables/s1/versions?artifact_kind=static_site',
        form,
      ),
    )

    expect(response.status).toBe(200)
    await expect(json(response)).resolves.toEqual({
      id: 's1',
      versionId: 'ver1',
      artifactKind: 'static_site',
      shareUrl: 'https://artifactshare.test/a/s1',
    })
    expect(beginStaticSiteBundleVersionUploadSessionMock).toHaveBeenCalledWith(
      { mocked: true },
      {
        id: 'u1',
        email: 'owner@example.com',
        workspaceId: 'ws1',
        hd: 'example.com',
      },
      's1',
      null,
      { waitUntil: expect.any(Function) },
    )
    const waitUntil =
      beginStaticSiteBundleVersionUploadSessionMock.mock.calls[0]?.[4].waitUntil
    const promise = Promise.resolve()
    waitUntil(promise)
    expect(waitUntilMock).toHaveBeenCalledWith(promise)
    expect(addFile).toHaveBeenCalledTimes(2)
    expect(commitVersion).toHaveBeenCalledTimes(1)
    expect(updateShareableMock).not.toHaveBeenCalled()
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
    expect(updateShareableMock).not.toHaveBeenCalled()
  })

  test('maps revoked workspace access to workspace-access-revoked', async () => {
    updateShareableMock.mockResolvedValue({ kind: 'workspace-access-revoked' })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'workspace-access-revoked' },
    })
    expect(updateShareableMock).toHaveBeenCalledTimes(1)
  })

  test('rejects users denied by Flagship before parsing the replacement body', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'not-allowed' })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(403)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'upload-not-allowed' },
    })
    expect(updateShareableMock).not.toHaveBeenCalled()
  })

  test('returns policy-unavailable when Flagship evaluation fails before parsing the replacement body', async () => {
    checkUploadAccessMock.mockResolvedValue({
      kind: 'flagship-error',
      error: new Error('flagship unavailable'),
    })
    const form = new FormData()
    form.append('file', new File(['<p>replacement</p>'], 'index.html'))

    const response = await action(actionArgs(form))

    expect(response.status).toBe(503)
    await expect(json(response)).resolves.toMatchObject({
      error: { code: 'upload-policy-unavailable' },
    })
    expect(updateShareableMock).not.toHaveBeenCalled()
  })
})
