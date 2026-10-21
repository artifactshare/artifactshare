const authorityMock = vi.hoisted(() => vi.fn())
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { CliAuthority } from '~/services/cli-authority.server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const moveShareableContainerMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  getCliAuthority: authorityMock,
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
    authorityMock.mockReset().mockReturnValue(null)
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

  test('real move service keeps unknown and unauthorized destinations indistinguishable', async () => {
    const fixture = createMigratedInMemoryDb()
    const actual = await vi.importActual<
      typeof import('~/services/shareables.server')
    >('~/services/shareables.server')
    moveShareableContainerMock.mockImplementation(actual.moveShareableContainer)
    createDbMock.mockReturnValue(fixture.db)
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'Workspace', '2026-01-01');
      INSERT INTO users (id, email, name, workspace_id, created_at, updated_at) VALUES ('u1', 'owner@example.com', 'Owner', 'ws1', '2026-01-01', '2026-01-01'), ('other', 'other@example.com', 'Other', 'ws1', '2026-01-01', '2026-01-01');
      INSERT INTO artifact_containers (id, workspace_id, kind, created_by_id, name, base_visibility, created_at, updated_at) VALUES ('private', 'ws1', 'project', 'other', 'Private', 'private', '2026-01-01', '2026-01-01');
      INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, container_id, created_at, updated_at) VALUES ('abc123def4', 'ws1', 'u1', 'Report', 'html_page', 'private', 'private', '2026-01-01', '2026-01-01');
    `)
    try {
      const before = fixture.sqlite.prepare('SELECT * FROM shareables').all()
      const bodies = []
      for (const id of ['missing', 'private']) {
        const response = await action({
          context: new Map(),
          params: { id: 'abc123def4' },
          request: new Request(
            'https://example.com/api/cli/shareables/abc123def4/move',
            {
              method: 'POST',
              body: JSON.stringify({ destination: { project_id: id } }),
            },
          ),
        } as never)
        expect(response.status).toBe(400)
        bodies.push(await response.json())
        expect(
          fixture.sqlite.prepare('SELECT * FROM shareables').all(),
        ).toEqual(before)
      }
      expect(bodies[0]).toEqual(bodies[1])
      expect(bodies[0]).toMatchObject({
        error: { code: 'invalid-destination' },
      })
    } finally {
      await fixture.db.destroy()
    }
  })

  test('denies unknown authority before mutation', async () => {
    authorityMock.mockReturnValue({
      kind: 'unknown',
    } as unknown as CliAuthority)
    const request = new Request(
      'https://example.test/api/cli/shareables/abc123def4/move',
      {
        method: 'POST',
        body: JSON.stringify({
          destination: { project_id: 'prj1' },
        }),
      },
    )
    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request,
    } as never)
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'scope-denied' },
    })
    expect(moveShareableContainerMock).not.toHaveBeenCalled()
    expect(request.bodyUsed).toBe(false)
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
      null,
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
      null,
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
