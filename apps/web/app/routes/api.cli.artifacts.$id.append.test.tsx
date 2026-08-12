import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const checkUploadAccessMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const appendShareableMock = vi.hoisted(() => vi.fn())
const ctxContextMock = vi.hoisted(() => ({}))

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  ctxContext: ctxContextMock,
  getCliAuthority: () => null,
  requireUser: requireUserMock,
}))
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: checkUploadAccessMock,
}))
vi.mock('~/services/db.server', () => ({ createDb: createDbMock }))
vi.mock('~/services/shareables.server', () => ({
  appendShareable: appendShareableMock,
}))
vi.mock('~/lib/api-errors', () => ({
  errorResponse: (code: string, message: string, status: number) =>
    Response.json({ error: { code, message } }, { status }),
}))
vi.mock('~/lib/create-version-response.server', () => ({
  createVersionFailureResponse: () => Response.json({}, { status: 500 }),
}))
vi.mock('~/lib/upload-permission-response.server', () => ({
  uploadPermissionFailureResponse: () => Response.json({}, { status: 403 }),
}))

import { action, middleware } from './api.cli.artifacts.$id.append'

describe('/api/cli/artifacts/:id/append', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    checkUploadAccessMock.mockReset().mockResolvedValue({ kind: 'allowed' })
    createDbMock.mockReset().mockReturnValue({})
    appendShareableMock.mockReset().mockResolvedValue({
      kind: 'ok',
      versionId: 'v2',
      artifactKind: 'html_page',
    })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('action forwards an HTML fragment to the shared append service', async () => {
    const waitUntil = vi.fn()
    const response = await action({
      context: new Map([[ctxContextMock, { waitUntil }]]),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4/append',
        {
          method: 'POST',
          body: JSON.stringify({ content: '<p>added</p>' }),
        },
      ),
    } as never)

    expect(response.status).toBe(200)
    expect(appendShareableMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'u1' }),
      'abc123def4',
      '<p>added</p>',
      expect.objectContaining({ waitUntil: expect.any(Function) }),
    )
    expect(await response.json()).toEqual({
      id: 'abc123def4',
      versionId: 'v2',
      shareUrl: 'https://artifactshare.test/a/abc123def4',
      artifactKind: 'html_page',
    })
  })
})
