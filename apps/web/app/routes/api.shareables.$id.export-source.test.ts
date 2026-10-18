import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const createDbMock = vi.hoisted(() => vi.fn())
const getExportSourceMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: {} },
}))
vi.mock('~/middleware/auth', () => ({
  requireUserApiMiddleware: requireUserApiMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
}))
vi.mock('~/services/export-source.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('~/services/export-source.server')>()),
  getExportSource: getExportSourceMock,
}))

import { loader, middleware } from './api.shareables.$id.export-source'

describe('/api/shareables/:id/export-source', () => {
  beforeEach(() => {
    requireUserApiMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    createDbMock.mockReset()
    getExportSourceMock.mockReset()
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

  test('returns export source JSON for an authorized viewer', async () => {
    getExportSourceMock.mockResolvedValue({
      kind: 'ok',
      data: {
        kind: 'markdown',
        artifactKind: 'markdown_page',
        path: '/report.md',
        versionId: 'ver123',
        source: '# Report',
        fileName: 'report.md',
      },
    })

    const response = await loader(loaderArgs('abc123def4'))
    const body = (await response.json()) as {
      kind: string
      source: string
      fileName: string
    }

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.status).toBe(200)
    expect(body.kind).toBe('markdown')
    expect(body.source).toBe('# Report')
    expect(body.fileName).toBe('report.md')
    expect(getExportSourceMock).toHaveBeenCalledWith(
      expect.anything(),
      {
        id: 'u1',
        email: 'viewer@example.com',
        name: 'Viewer',
        image: null,
        workspaceId: 'ws1',
        hd: 'example.com',
        locale: 'en',
      },
      { id: 'abc123def4', path: null, versionId: null },
    )
  })

  test('passes the path query to getExportSource', async () => {
    getExportSourceMock.mockResolvedValue({
      kind: 'ok',
      data: {
        kind: 'html',
        artifactKind: 'static_site',
        path: '/about.html',
        versionId: 'ver999',
        source: '<html></html>',
        fileName: 'about.html',
      },
    })

    const response = await loader(
      loaderArgs(
        'site123abc',
        'https://artifactshare.test/api/shareables/site123abc/export-source?path=%2Fabout.html',
      ),
    )

    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.status).toBe(200)
    expect(getExportSourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        id: 'site123abc',
        path: '/about.html',
        versionId: null,
      },
    )
  })

  test('returns not-found without leaking missing or inaccessible shareables', async () => {
    getExportSourceMock.mockResolvedValue({ kind: 'not-found' })

    const response = await loader(loaderArgs('nope'))
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(404)
    expect(body.error.code).toBe('not-found')
  })

  test('returns unsupported-kind for non-exportable artifact kinds', async () => {
    getExportSourceMock.mockResolvedValue({
      kind: 'unsupported-kind',
      artifactKind: 'spa',
    })

    const response = await loader(loaderArgs('spa123abcd'))
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('unsupported-kind')
  })

  test('returns non-html-source for static site paths that are not HTML', async () => {
    getExportSourceMock.mockResolvedValue({
      kind: 'non-html-source',
      path: '/assets/app.js',
      contentType: 'text/javascript',
    })

    const response = await loader(
      loaderArgs(
        'site123abc',
        'https://artifactshare.test/api/shareables/site123abc/export-source?path=%2Fassets%2Fapp.js',
      ),
    )
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(400)
    expect(body.error.code).toBe('non-html-source')
  })

  test('returns source-unavailable when stored source is missing', async () => {
    getExportSourceMock.mockResolvedValue({ kind: 'source-unavailable' })

    const response = await loader(loaderArgs('abc123def4'))
    const body = (await response.json()) as { error: { code: string } }

    expect(response.status).toBe(409)
    expect(body.error.code).toBe('source-unavailable')
  })
})

test('source revalidation forwards the expected version and storage errors are not cacheable', async () => {
  getExportSourceMock.mockRejectedValue(new Error('Storage failed'))
  const response = await loader(
    loaderArgs(
      'artifact-1',
      'https://artifactshare.test/api/shareables/artifact-1/export-source?path=%2Fguide%2Freport.html&versionId=version-1',
    ),
  )
  expect(getExportSourceMock).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    { id: 'artifact-1', path: '/guide/report.html', versionId: 'version-1' },
  )
  expect(response.status).toBe(409)
  expect(response.headers.get('cache-control')).toBe('no-store')
})

function loaderArgs(id: string, url?: string) {
  return {
    context: new Map(),
    params: { id },
    url: new URL(
      url ?? `https://artifactshare.test/api/shareables/${id}/export-source`,
    ),
    request: new Request(
      url ?? `https://artifactshare.test/api/shareables/${id}/export-source`,
    ),
  } as never
}

test('uses normalized loader query rather than the raw data request URL', async () => {
  getExportSourceMock.mockResolvedValue({ kind: 'not-found' })
  const response = await loader({
    context: new Map(),
    params: { id: 'artifact-1' },
    request: new Request(
      'https://artifactshare.test/raw?versionId=wrong&path=/wrong.html',
    ),
    url: new URL(
      'https://artifactshare.test/api/shareables/artifact-1/export-source?versionId=version-1&path=/report.html',
    ),
  } as never)
  expect(getExportSourceMock).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    { id: 'artifact-1', versionId: 'version-1', path: '/report.html' },
  )
  expect(response.headers.get('cache-control')).toBe('no-store')
})
