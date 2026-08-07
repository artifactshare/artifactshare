import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const listCliArtifactsMock = vi.hoisted(() => vi.fn())

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
vi.mock('~/services/cli-artifacts.server', () => ({
  listCliArtifacts: listCliArtifactsMock,
}))

import { loader, middleware } from './api.cli.artifacts'

describe('/api/cli/artifacts', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    createDbMock.mockReset()
    listCliArtifactsMock.mockReset()
    createDbMock.mockReturnValue({
      destroy: vi.fn().mockResolvedValue(undefined),
    })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('returns artifacts for the authenticated user', async () => {
    listCliArtifactsMock.mockResolvedValue({
      kind: 'ok',
      data: {
        artifacts: [
          {
            id: 'abc123def4',
            title: 'Weekly report',
            share_url: 'https://example.test/a/abc123def4',
            visibility: 'private',
            updated_at: '2026-06-18T00:00:00.000Z',
            project_id: null,
          },
        ],
        limit: 50,
        has_more: false,
        next_cursor: null,
      },
    })

    const response = await loader({
      context: new Map(),
      request: new Request(
        'https://example.test/api/cli/artifacts?project_id=&query=report',
      ),
    } as never)
    const body = (await response.json()) as {
      artifacts: Array<{ id: string }>
      has_more: boolean
    }

    expect(response.status).toBe(200)
    expect(body.artifacts[0]?.id).toBe('abc123def4')
    expect(body.has_more).toBe(false)
    expect(listCliArtifactsMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'u1',
        email: 'owner@example.com',
        workspaceId: 'ws1',
        hd: 'example.com',
      },
      {
        baseUrl: 'https://example.test',
        projectId: '',
        query: 'report',
      },
    )
  })

  test('maps invalid cursors to validation_failed', async () => {
    listCliArtifactsMock.mockResolvedValue({ kind: 'invalid-cursor' })

    const response = await loader({
      context: new Map(),
      request: new Request(
        'https://example.test/api/cli/artifacts?cursor=broken',
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('validation_failed')
    expect(listCliArtifactsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ cursor: 'broken' }),
    )
  })

  test('maps invalid project filters to invalid-destination', async () => {
    listCliArtifactsMock.mockResolvedValue({ kind: 'invalid-project' })

    const response = await loader({
      context: new Map(),
      request: new Request(
        'https://example.test/api/cli/artifacts?project_id=missing',
      ),
    } as never)
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('invalid-destination')
  })
})
