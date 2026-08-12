import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const getCliAuthorityMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const getArtifactReadbackMock = vi.hoisted(() => vi.fn())
const deleteShareableMock = vi.hoisted(() => vi.fn())

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
vi.mock('~/services/artifact-readback-service.server', () => ({
  getArtifactReadback: getArtifactReadbackMock,
}))
vi.mock('~/services/shareables.server', () => ({
  deleteShareable: deleteShareableMock,
}))

import { action, loader, middleware } from './api.cli.artifacts.$id'

describe('/api/cli/artifacts/:id', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    getCliAuthorityMock.mockReset()
    getCliAuthorityMock.mockReturnValue(null)
    createDbMock.mockReset()
    getArtifactReadbackMock.mockReset()
    deleteShareableMock.mockReset()
    createDbMock.mockReturnValue({
      destroy: vi.fn().mockResolvedValue(undefined),
    })
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      name: 'Owner',
      image: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      locale: 'en',
    })
  })

  test('rejects invalid offset before opening the database', async () => {
    const response = await loader({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4?offset=-1',
      ),
    } as never)
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('invalid-offset')
    expect(createDbMock).not.toHaveBeenCalled()
  })

  test('rejects invalid include values before opening the database', async () => {
    const response = await loader({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4?include=owners',
      ),
    } as never)
    const body = (await response.json()) as {
      error: { code: string; message: string }
    }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('invalid-include')
    expect(createDbMock).not.toHaveBeenCalled()
  })

  test('returns artifact source for the authenticated user', async () => {
    getArtifactReadbackMock.mockResolvedValue({
      kind: 'ok',
      data: {
        id: 'abc123def4',
        share_url: 'https://artifactshare.test/a/abc123def4',
        version_id: 'ver123',
        format: 'markdown',
        content: '# Report',
        size_bytes: 8,
        truncated: false,
        next_offset: null,
      },
    })

    const response = await loader({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4?offset=200000&include=versions,comments',
      ),
    } as never)
    const body = (await response.json()) as {
      id: string
      version_id: string
      format: string
      content: string
    }

    expect(response.status).toBe(200)
    expect(body.id).toBe('abc123def4')
    expect(body.version_id).toBe('ver123')
    expect(body.format).toBe('markdown')
    expect(body.content).toBe('# Report')
    expect(getArtifactReadbackMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'u1',
        email: 'owner@example.com',
        name: 'Owner',
        image: null,
        workspaceId: 'ws1',
        hd: 'example.com',
        locale: 'en',
      },
      {
        id: 'abc123def4',
        baseUrl: 'https://artifactshare.test',
        offset: 200000,
        include: ['versions', 'comments'],
      },
    )
  })

  test('returns not-found without leaking missing or inaccessible artifacts', async () => {
    getArtifactReadbackMock.mockResolvedValue({ kind: 'not-found' })

    const response = await loader({
      context: new Map(),
      params: { id: 'nope' },
      request: new Request('https://artifactshare.test/api/cli/artifacts/nope'),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })

  test('returns unsupported-kind for multi-file artifacts', async () => {
    getArtifactReadbackMock.mockResolvedValue({
      kind: 'unsupported-kind',
      artifactKind: 'static_site',
    })

    const response = await loader({
      context: new Map(),
      params: { id: 'site123abc' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/site123abc',
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('unsupported-kind')
  })

  test('deletes an artifact for the authenticated owner', async () => {
    deleteShareableMock.mockResolvedValue({ kind: 'ok' })

    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4',
        { method: 'DELETE' },
      ),
    } as never)
    const body = (await response.json()) as { id: string; deleted: boolean }

    expect(response.status).toBe(200)
    expect(body).toEqual({ id: 'abc123def4', deleted: true })
    expect(deleteShareableMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'u1',
        email: 'owner@example.com',
        name: 'Owner',
        image: null,
        workspaceId: 'ws1',
        hd: 'example.com',
        locale: 'en',
      },
      'abc123def4',
    )
  })

  test('returns not-found for missing or inaccessible artifact deletes', async () => {
    deleteShareableMock.mockResolvedValue({ kind: 'not-found' })

    const response = await action({
      context: new Map(),
      params: { id: 'nope' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/nope',
        {
          method: 'DELETE',
        },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })

  test('maps delete storage failures', async () => {
    deleteShareableMock.mockResolvedValue({ kind: 'delete-failed' })

    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4',
        { method: 'DELETE' },
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(502)
    expect(body.error.code).toBe('delete-failed')
  })

  test('rejects unsupported methods for write requests', async () => {
    const response = await action({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4',
        { method: 'PATCH' },
      ),
    } as never)

    expect(response.status).toBe(405)
    expect(deleteShareableMock).not.toHaveBeenCalled()
  })
})
