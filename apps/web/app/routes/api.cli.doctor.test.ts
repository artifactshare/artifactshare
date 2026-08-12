import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const getCliAuthorityMock = vi.hoisted(() => vi.fn())
const checkUploadAccessMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const logUploadPermissionFailureMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
  getCliAuthority: getCliAuthorityMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
  withDb: (fn: (db: unknown) => unknown) => fn(createDbMock()),
}))
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: checkUploadAccessMock,
}))
vi.mock('~/lib/upload-permission.server', () => ({
  logUploadPermissionFailure: logUploadPermissionFailureMock,
}))

import { loader, middleware } from './api.cli.doctor'

describe('/api/cli/doctor', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    logUploadPermissionFailureMock.mockReset()
    requireUserMock.mockReset()
    getCliAuthorityMock.mockReset()
    checkUploadAccessMock.mockReset()
    createDbMock.mockReturnValue({
      destroy: vi.fn().mockResolvedValue(undefined),
    })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
    getCliAuthorityMock.mockReturnValue({ kind: 'unrestricted' })
  })

  test('reports the project selected by an agent credential', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'allowed' })
    getCliAuthorityMock.mockReturnValue({
      kind: 'agent',
      projectId: 'prj-agent',
    })

    const response = await loader({ context: new Map() } as never)
    const body = (await response.json()) as {
      auth: {
        authority: { preset: string; project_id: string | null }
      }
    }

    expect(body.auth.authority).toEqual({
      preset: 'agent',
      project_id: 'prj-agent',
    })
  })

  test('returns upload ok when publish is allowed', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'allowed' })

    const response = await loader({ context: new Map() } as never)
    const body = (await response.json()) as {
      auth: { ok: boolean }
      upload: { ok: boolean }
      user: { email: string }
    }

    expect(response.status).toBe(200)
    expect(body.auth.ok).toBe(true)
    expect(body.upload.ok).toBe(true)
    expect(body.user.email).toBe('owner@example.com')
  })

  test('returns upload failure without throwing when publish is blocked', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'not-allowed' })

    const response = await loader({ context: new Map() } as never)
    const body = (await response.json()) as {
      upload: { ok: boolean; code: string }
    }

    expect(response.status).toBe(200)
    expect(body.upload.ok).toBe(false)
    expect(body.upload.code).toBe('upload-not-allowed')
    expect(logUploadPermissionFailureMock).toHaveBeenCalledWith({
      kind: 'not-allowed',
    })
  })

  test('returns self-upload disabled diagnostic without throwing', async () => {
    checkUploadAccessMock.mockResolvedValue({ kind: 'self-upload-disabled' })

    const response = await loader({ context: new Map() } as never)
    const body = (await response.json()) as {
      upload: { ok: boolean; code: string }
    }

    expect(response.status).toBe(200)
    expect(body.upload.ok).toBe(false)
    expect(body.upload.code).toBe('self-upload-disabled')
    expect(logUploadPermissionFailureMock).toHaveBeenCalledWith({
      kind: 'self-upload-disabled',
    })
  })
})
