import { createRequestHandler, type ServerBuild } from 'react-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const getCliDownloadFileMock = vi.hoisted(() => vi.fn())

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
  getCliDownloadFile: getCliDownloadFileMock,
}))

import { loader, middleware } from './api.cli.artifacts.$id.download.$'

describe('/api/cli/artifacts/:id/download/*', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    createDbMock.mockReset()
    getCliDownloadFileMock.mockReset()
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

  test.each([
    [
      '/data/AA から BB CC_dd.data',
      'data/AA%20%E3%81%8B%E3%82%89%20BB%20CC_dd%2Edata',
    ],
    ['/assets.v1/app.min.js', 'assets%2Ev1/app%2Emin%2Ejs'],
    ['/data/literal%2E%23%3F.data', 'data/literal%252E%2523%253F%2Edata'],
  ])('downloads %s through the real router', async (path, encodedPath) => {
    const bytes = 'selected data bytes'
    getCliDownloadFileMock.mockImplementation(async (_db, _user, input) =>
      input.path === path
        ? {
            kind: 'ok',
            file: { path, content_type: 'application/octet-stream' },
            object: { body: new Blob([bytes]).stream(), size: bytes.length },
          }
        : { kind: 'not-found' },
    )
    const routedLoader = vi.fn(loader)
    // Resource routes have no default component; ServerBuild requires one.
    const handler = createRequestHandler(
      {
        entry: { module: { default: () => new Response('document') } },
        routes: {
          download: {
            id: 'download',
            path: 'api/cli/artifacts/:id/download/*',
            module: { loader: routedLoader },
          },
        },
        assets: { routes: {}, entry: { module: '' }, url: '', version: 'test' },
        publicPath: '/',
        assetsBuildDirectory: 'build/client',
        future: {},
        ssr: true,
        isSpaMode: false,
        prerender: [],
        routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
      } as unknown as ServerBuild,
      'test',
    )
    const response = await handler(
      new Request(
        `https://artifactshare.test/api/cli/artifacts/site123abc/download/${encodedPath}`,
      ),
    )
    expect(routedLoader.mock.calls[0]?.[0].params['*']).toBe(path.slice(1))
    expect(getCliDownloadFileMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.anything(),
      { id: 'site123abc', path },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(
      'application/octet-stream',
    )
    expect(response.headers.get('content-length')).toBe(String(bytes.length))
    expect(await response.text()).toBe(bytes)
    expectDownloadSecurityHeaders(response)
    if (path.endsWith('.data')) {
      // Before the CLI fix this success assertion failed: Single Fetch stripped
      // .data, producing the splat "data/AA から BB CC_dd" and a missing file.
      const literalUrl = new URL(
        `/api/cli/artifacts/site123abc/download/${path.split('/').filter(Boolean).map(encodeURIComponent).join('/')}`,
        'https://artifactshare.test',
      )
      const literalResponse = await handler(new Request(literalUrl))
      expect(routedLoader.mock.calls.at(-1)?.[0].params['*']).toBe(
        path.slice(1, -5),
      )
      expect(getCliDownloadFileMock).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        { id: 'site123abc', path: path.slice(0, -5) },
      )
      expect(literalResponse.status).toBe(404)
      await literalResponse.text()
    }
  })

  test('returns the selected file stream', async () => {
    getCliDownloadFileMock.mockResolvedValue({
      kind: 'ok',
      file: {
        path: '/assets/app.js',
        size_bytes: 14,
        content_type: 'text/javascript',
        sha256: 'sha-app',
      },
      object: {
        body: new Blob(['console.log(1)']).stream(),
        size: 14,
      },
    })

    const response = await loader({
      context: new Map(),
      params: { id: 'site123abc', '*': 'assets/app.js' },
    } as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/javascript')
    expect(response.headers.get('content-length')).toBe('14')
    expectDownloadSecurityHeaders(response)
    expect(await response.text()).toBe('console.log(1)')
    expect(getCliDownloadFileMock).toHaveBeenCalledWith(
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
        id: 'site123abc',
        path: '/assets/app.js',
      },
    )
  })

  test.each([
    ['text/html', '<script>alert(1)</script>'],
    ['image/svg+xml', '<svg><script>alert(1)</script></svg>'],
  ])(
    'returns active MIME %s with download security headers',
    async (contentType, body) => {
      getCliDownloadFileMock.mockResolvedValue({
        kind: 'ok',
        file: {
          path: '/index',
          size_bytes: body.length,
          content_type: contentType,
          sha256: 'sha',
        },
        object: { body: new Blob([body]).stream(), size: body.length },
      })
      const response = await loader({
        context: new Map(),
        params: { id: 'site123abc', '*': 'index' },
      } as never)
      expect(response.headers.get('content-type')).toBe(contentType)
      expect(response.headers.get('content-length')).toBe(String(body.length))
      expect(await response.text()).toBe(body)
      expectDownloadSecurityHeaders(response)
    },
  )

  test('returns not-found for unavailable paths', async () => {
    getCliDownloadFileMock.mockResolvedValue({ kind: 'not-found' })

    const response = await loader({
      context: new Map(),
      params: { id: 'site123abc', '*': 'missing.js' },
    } as never)
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })
})

function expectDownloadSecurityHeaders(response: Response) {
  expect(response.headers.get('content-disposition')).toBe('attachment')
  expect(response.headers.get('x-content-type-options')).toBe('nosniff')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(response.headers.get('content-security-policy')).toBe(
    "default-src 'none'; frame-ancestors 'none'; form-action 'none'",
  )
}
