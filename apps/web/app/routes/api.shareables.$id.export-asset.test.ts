import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const getExportAssetMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: {} },
}))
vi.mock('~/middleware/auth', () => ({
  requireUserApiMiddleware: vi.fn(),
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
}))
vi.mock('~/services/export-source.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/export-source.server')>()),
  getExportAsset: getExportAssetMock,
}))

import { loader } from './api.shareables.$id.export-asset.$'

describe('/api/shareables/:id/export-asset/*', () => {
  beforeEach(() => {
    requireUserMock.mockReset()
    createDbMock.mockReset()
    getExportAssetMock.mockReset()
    createDbMock.mockReturnValue({})
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'viewer@example.com',
      name: 'Viewer',
      image: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      locale: 'en',
    })
  })

  test('serves passive assets with nosniff', async () => {
    getExportAssetMock.mockResolvedValue({
      kind: 'ok',
      object: {
        body: new Blob(['body { color: red; }']).stream(),
        text: vi.fn().mockResolvedValue('body { color: red; }'),
        size: 20,
      },
      path: '/style.css',
      contentType: 'text/css',
    })

    const response = await loader(loaderArgs('site123abc', 'style.css'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/css')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    await expect(response.text()).resolves.toBe('body { color: red; }')
  })

  test('serves MP4 video with its declared content type', async () => {
    getExportAssetMock.mockResolvedValue({
      kind: 'ok',
      object: {
        body: new Blob(['video']).stream(),
        size: 5,
      },
      path: '/demo.mp4',
      contentType: 'video/mp4',
    })

    const response = await loader(loaderArgs('site123abc', 'demo.mp4'))

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('content-length')).toBe('5')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  })

  test('returns CSS acquisition bytes unchanged with no-store and exact version', async () => {
    const css = '@import "nested/theme.css"; a { background: url(/image.png) }'
    getExportAssetMock.mockResolvedValue({
      kind: 'ok',
      object: { body: new Blob([css]).stream(), size: css.length },
      path: '/style.css',
      contentType: 'text/css',
    })
    const response = await loader(loaderArgs('artifact-1', 'style.css'))
    expect(await response.text()).toBe(css)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(getExportAssetMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { id: 'artifact-1', path: '/style.css', versionId: 'version-1' },
    )
  })

  test('rejects active HTML assets on the app origin', async () => {
    getExportAssetMock.mockResolvedValue({
      kind: 'ok',
      object: {
        body: new Blob(['<script>location.href="/"</script>']).stream(),
        size: 36,
      },
      path: '/page.html',
      contentType: 'text/html',
    })

    const response = await loader(loaderArgs('site123abc', 'page.html'))
    const body = (await response.json()) as { error: { code: string } }

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('unsafe-export-asset')
  })
})

function loaderArgs(id: string, path: string) {
  return {
    context: new Map(),
    params: { id, '*': path },
    request: new Request(
      `https://artifactshare.test/api/shareables/${id}/export-asset/${path}?versionId=version-1`,
    ),
  } as never
}
