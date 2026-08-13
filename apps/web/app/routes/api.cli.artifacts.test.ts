import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const getCliAuthorityMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const listCliArtifactsMock = vi.hoisted(() => vi.fn())
const listAgentReadableArtifactsMock = vi.hoisted(() => vi.fn())

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
vi.mock('~/services/cli-artifacts.server', () => ({
  listCliArtifacts: listCliArtifactsMock,
  listAgentReadableArtifacts: listAgentReadableArtifactsMock,
}))

import { loader, middleware } from './api.cli.artifacts'

describe('/api/cli/artifacts', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    getCliAuthorityMock.mockReset()
    getCliAuthorityMock.mockReturnValue(null)
    createDbMock.mockReset()
    listCliArtifactsMock.mockReset()
    listAgentReadableArtifactsMock.mockReset()
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

  test('routes agent listings through the widened read scope, including other projects', async () => {
    getCliAuthorityMock.mockReturnValue({
      kind: 'agent',
      familyId: 'family-1',
      workspaceId: 'ws1',
      projectId: 'project-1',
      projectNameSnapshot: 'Approved project',
      agentProfileId: 'agent-1',
    })
    listAgentReadableArtifactsMock.mockResolvedValue({
      kind: 'ok',
      data: { artifacts: [], limit: 50, has_more: false, next_cursor: null },
    })

    const response = await loader({
      context: new Map(),
      request: new Request(
        'https://example.test/api/cli/artifacts?project_id=project-2',
      ),
    } as never)

    expect(response.status).toBe(200)
    expect(listAgentReadableArtifactsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ projectId: 'project-1' }),
      expect.objectContaining({ projectId: 'project-2' }),
    )
    expect(listCliArtifactsMock).not.toHaveBeenCalled()
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
