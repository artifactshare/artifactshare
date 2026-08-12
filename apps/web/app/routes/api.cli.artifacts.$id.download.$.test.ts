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
