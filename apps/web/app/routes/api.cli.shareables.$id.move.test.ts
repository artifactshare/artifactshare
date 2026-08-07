import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const moveShareableContainerMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
  withDb: (fn: (db: unknown) => unknown) => fn(createDbMock()),
}))
vi.mock('~/services/shareables.server', () => ({
  moveShareableContainer: moveShareableContainerMock,
}))

import { action, middleware } from './api.cli.shareables.$id.move'

describe('/api/cli/shareables/:id/move', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    createDbMock.mockReset()
    moveShareableContainerMock.mockReset()
    createDbMock.mockReturnValue({})
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
    moveShareableContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'prj1',
      containerName: 'Launch',
      visibility: 'project',
      projectAudienceMayChange: true,
    })
  })

  test('moves a shareable into a project for the authenticated user', async () => {
    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/move',
        {
          method: 'POST',
          body: JSON.stringify({ destination: { project_id: 'prj1' } }),
        },
      ),
    } as never)
    const body = (await response.json()) as {
      destination: { type: string; project_id: string }
      share: { visibility: string; project_audience_may_change: boolean }
    }

    expect(response.status).toBe(200)
    expect(moveShareableContainerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'u1', workspaceId: 'ws1' }),
      'abc123def4',
      { type: 'project', projectId: 'prj1' },
    )
    expect(body.destination).toEqual({ type: 'project', project_id: 'prj1' })
    expect(body.share).toEqual({
      visibility: 'project',
      project_audience_may_change: true,
    })
  })

  test('moves a shareable home', async () => {
    moveShareableContainerMock.mockResolvedValue({
      kind: 'ok',
      containerId: 'inbox-owner',
      containerName: 'Unsorted',
      visibility: 'private',
      projectAudienceMayChange: false,
    })

    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/move',
        { method: 'POST', body: JSON.stringify({ destination: 'home' }) },
      ),
    } as never)
    const body = (await response.json()) as {
      destination: { type: string; project_id: string | null }
      share: { visibility: string }
    }

    expect(response.status).toBe(200)
    expect(moveShareableContainerMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'abc123def4',
      { type: 'inbox' },
    )
    expect(body.destination).toEqual({ type: 'home', project_id: null })
    expect(body.share.visibility).toBe('private')
  })

  test('returns not-found without leaking inaccessible shareables', async () => {
    moveShareableContainerMock.mockResolvedValue({ kind: 'not-found' })

    const response = await action({
      context: new Map(),
      params: { id: 'missing' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/missing/move',
        { method: 'POST', body: JSON.stringify({ destination: 'home' }) },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })

  test('returns invalid-destination for bad destination input', async () => {
    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/shareables/abc123def4/move',
        { method: 'POST', body: JSON.stringify({ destination: null }) },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('invalid-destination')
    expect(moveShareableContainerMock).not.toHaveBeenCalled()
  })
})
