const getCliAuthorityMock = vi.hoisted(() => vi.fn())
import type { CliAuthority } from '~/services/cli-authority.server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const getPublisherDownloadFileMock = vi.hoisted(() => vi.fn())
const getCliDownloadManifestMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  getCliAuthority: getCliAuthorityMock,
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
  withDb: (fn: (db: unknown) => unknown) => fn(createDbMock()),
}))
vi.mock('~/services/publisher-scope.server', () => ({
  loadPublisherArtifact: vi.fn(async () => ({ artifact_kind: 'html_page' })),
}))
vi.mock('~/services/cli-download.server', () => ({
  getCliDownloadManifest: getCliDownloadManifestMock,
  getPublisherDownloadFile: getPublisherDownloadFileMock,
}))

import { loader, middleware } from './api.cli.artifacts.$id.download'

describe('/api/cli/artifacts/:id/download', () => {
  beforeEach(() => {
    getCliAuthorityMock.mockReset().mockReturnValue(null)
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

  test('denies an unknown authority for GET before accessing artifact or project data', async () => {
    getCliAuthorityMock.mockReturnValue({
      kind: 'unknown',
    } as unknown as CliAuthority)
    const response = await loader({
      context: new Map(),
      params: { id: 'abc123def4', '*': 'index.md' },
      request: new Request(
        'https://example.test/api/cli/artifacts/abc123def4?q=report',
        { method: 'GET' },
      ),
    } as never)
    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: 'scope-denied' },
    })
    expect(getCliDownloadManifestMock).not.toHaveBeenCalled()
  })

  test('publisher exact download streams source with restrictive attachment headers instead of a manifest', async () => {
    getCliAuthorityMock.mockReturnValue({
      kind: 'publisher',
      familyId: 'family1',
      workspaceId: 'ws1',
      publisherClientId: 'client1',
      publisherClientName: 'Reports',
    })
    getPublisherDownloadFileMock.mockResolvedValue({
      kind: 'ok',
      file: { content_type: 'text/html' },
      object: { body: new Blob(['<p>Report</p>']).stream(), size: 13 },
    })
    const response = await loader({
      context: new Map(),
      params: { id: 'abc123def4' },
      request: new Request(
        'https://example.test/api/cli/artifacts/abc123def4/download',
      ),
    } as never)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-disposition')).toBe('attachment')
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('content-security-policy')).toContain(
      "default-src 'none'",
    )
    expect(await response.text()).toBe('<p>Report</p>')
    expect(getCliDownloadManifestMock).not.toHaveBeenCalled()
  })

  test.each(['sha-index', ''])(
    'returns a download manifest preserving sha256=%j',
    async (sha256) => {
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
              sha256,
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
        files: Array<{ path: string; sha256: string }>
      }

      expect(response.status).toBe(200)
      expect(body.id).toBe('abc123def4')
      expect(body.version_id).toBe('ver123')
      expect(body.files[0]?.path).toBe('/index.md')
      expect(body.files[0]?.sha256).toBe(sha256)
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
    },
  )

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
