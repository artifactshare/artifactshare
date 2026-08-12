import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const getCliDownloadManifestMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  getCliAuthority: () => null,
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
  withDb: (fn: (db: unknown) => unknown) => fn(createDbMock()),
}))
vi.mock('~/services/cli-download.server', () => ({
  getCliDownloadManifest: getCliDownloadManifestMock,
}))

import { loader, middleware } from './api.cli.artifacts.$id.download'

describe('/api/cli/artifacts/:id/download', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    createDbMock.mockReset()
    getCliDownloadManifestMock.mockReset()
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

  test('returns a download manifest for the authenticated user', async () => {
    getCliDownloadManifestMock.mockResolvedValue({
      kind: 'ok',
      data: {
        id: 'abc123def4',
        share_url: 'https://artifactshare.test/a/abc123def4',
        version_id: 'ver123',
        artifact_kind: 'markdown_page',
        files: [
          {
            path: '/index.md',
            size_bytes: 8,
            content_type: 'text/markdown',
            sha256: '',
          },
        ],
        total_size_bytes: 8,
      },
    })

    const response = await loader({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/abc123def4/download',
      ),
    } as never)
    const body = (await response.json()) as {
      id: string
      version_id: string
      files: Array<{ path: string }>
    }

    expect(response.status).toBe(200)
    expect(body.id).toBe('abc123def4')
    expect(body.version_id).toBe('ver123')
    expect(body.files[0]?.path).toBe('/index.md')
    expect(getCliDownloadManifestMock).toHaveBeenCalledWith(
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
      },
    )
  })

  test('returns not-found without leaking missing or inaccessible artifacts', async () => {
    getCliDownloadManifestMock.mockResolvedValue({ kind: 'not-found' })

    const response = await loader({
      context: new Map(),
      params: { id: 'nope' },
      request: new Request(
        'https://artifactshare.test/api/cli/artifacts/nope/download',
      ),
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })
})
