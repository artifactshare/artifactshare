import { beforeEach, describe, expect, test, vi } from 'vitest'

const loadCommentAccessMock = vi.hoisted(() => vi.fn())
const getArtifactMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: {} },
}))
vi.mock('~/services/comments.server', () => ({
  loadCommentAccess: loadCommentAccessMock,
}))
vi.mock('~/services/storage.server', () => ({
  getArtifact: getArtifactMock,
}))

import {
  exportSourceErrorResponse,
  getExportAsset,
  getExportSource,
  isHtmlContent,
  isPassiveExportAssetContent,
  normalizeExportPath,
} from './export-source.server'

const user = {
  id: 'u1',
  email: 'viewer@example.com',
  emailVerified: true,
  name: 'Viewer',
  image: null,
  workspaceId: 'ws1',
  hd: 'example.com',
  msTenantId: null,
  kind: 'human' as const,
  locale: 'en',
}

describe('normalizeExportPath', () => {
  test('defaults empty paths to /index.html', () => {
    expect(normalizeExportPath('')).toBe('/index.html')
    expect(normalizeExportPath('/')).toBe('/index.html')
    expect(normalizeExportPath(undefined)).toBe('/index.html')
  })

  test('adds a leading slash and strips query and hash', () => {
    expect(normalizeExportPath('about.html')).toBe('/about.html')
    expect(normalizeExportPath('/about.html?tab=1#section')).toBe('/about.html')
  })

  test('decodes percent-encoded path segments', () => {
    expect(normalizeExportPath('/docs/my%20page.html')).toBe(
      '/docs/my page.html',
    )
  })

  test('uses a custom default path', () => {
    expect(normalizeExportPath('', '/index.md')).toBe('/index.md')
  })
})

describe('isHtmlContent', () => {
  test('accepts HTML mime types and extensions', () => {
    expect(isHtmlContent('/index.html', 'text/html; charset=utf-8')).toBe(true)
    expect(isHtmlContent('/page.xhtml', 'application/xhtml+xml')).toBe(true)
    expect(isHtmlContent('/legacy.htm', 'application/octet-stream')).toBe(true)
  })

  test('rejects non-HTML sources', () => {
    expect(isHtmlContent('/assets/app.js', 'text/javascript')).toBe(false)
    expect(isHtmlContent('/styles/app.css', 'text/css')).toBe(false)
  })
})

describe('isPassiveExportAssetContent', () => {
  test('accepts passive print assets', () => {
    expect(isPassiveExportAssetContent('/style.css', 'text/css')).toBe(true)
    expect(isPassiveExportAssetContent('/image.png', 'image/png')).toBe(true)
    expect(isPassiveExportAssetContent('/font.woff2', 'font/woff2')).toBe(true)
  })

  test('rejects active document and script assets', () => {
    expect(isPassiveExportAssetContent('/page.html', 'text/html')).toBe(false)
    expect(isPassiveExportAssetContent('/app.js', 'text/javascript')).toBe(
      false,
    )
    expect(isPassiveExportAssetContent('/fake.png', 'text/javascript')).toBe(
      false,
    )
    expect(isPassiveExportAssetContent('/icon.svg', 'image/svg+xml')).toBe(
      false,
    )
  })
})

describe('getExportSource', () => {
  beforeEach(() => {
    loadCommentAccessMock.mockReset()
    getArtifactMock.mockReset()
  })

  test('returns markdown source for markdown_page artifacts', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'abc123def4',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver123',
      artifactKind: 'markdown_page',
      entrypointPath: '/report.md',
      r2Key: 'ws1/abc123def4/ver123/report.md',
      isTeamWorkspaceAdmin: false,
    })
    getArtifactMock.mockResolvedValue({
      text: vi.fn().mockResolvedValue('# Report'),
      httpMetadata: { contentType: 'text/markdown; charset=utf-8' },
    })

    const result = await getExportSource({} as never, user, {
      id: 'abc123def4',
    })

    expect(result).toEqual({
      kind: 'ok',
      data: {
        kind: 'markdown',
        artifactKind: 'markdown_page',
        path: '/report.md',
        versionId: 'ver123',
        source: '# Report',
        fileName: 'report.md',
        renderedHtml: expect.stringContaining('<h1 id="report">Report</h1>'),
      },
    })
  })

  test('returns html source for html_page artifacts', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'html123abc',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver123',
      artifactKind: 'html_page',
      entrypointPath: '/demo.html',
      r2Key: 'ws1/html123abc/ver123/demo.html',
      isTeamWorkspaceAdmin: false,
    })
    getArtifactMock.mockResolvedValue({
      text: vi.fn().mockResolvedValue('<html></html>'),
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    })

    const result = await getExportSource({} as never, user, {
      id: 'html123abc',
    })

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toMatchObject({
      kind: 'html',
      artifactKind: 'html_page',
      path: '/demo.html',
      fileName: 'demo.html',
      source: '<html></html>',
    })
  })

  test('returns html source for a static site path from version_files', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'site123abc',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver999',
      artifactKind: 'static_site',
      entrypointPath: '/index.html',
      r2Key: 'ws1/site123abc/ver999/index.html',
      isTeamWorkspaceAdmin: false,
    })
    getArtifactMock.mockResolvedValue({
      text: vi.fn().mockResolvedValue('<html><body>About</body></html>'),
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    })

    const result = await getExportSource(
      versionFileDb({
        path: '/about.html',
        r2_key: 'ws1/site123abc/ver999/about.html',
        mime_type: 'text/html',
      }) as never,
      user,
      { id: 'site123abc', path: '/about.html' },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toMatchObject({
      kind: 'html',
      artifactKind: 'static_site',
      path: '/about.html',
      fileName: 'about.html',
    })
    expect(getArtifactMock).toHaveBeenCalledWith(
      {},
      'ws1/site123abc/ver999/about.html',
    )
  })

  test('returns index html source for static site fallback routes', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'site123abc',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver999',
      artifactKind: 'static_site',
      entrypointPath: '/index.html',
      r2Key: 'ws1/site123abc/ver999/index.html',
      isTeamWorkspaceAdmin: false,
    })
    getArtifactMock.mockResolvedValue({
      text: vi.fn().mockResolvedValue('<html><body>Dashboard</body></html>'),
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    })

    const result = await getExportSource(
      versionFileDb([
        {
          path: '/index.html',
          r2_key: 'ws1/site123abc/ver999/index.html',
          mime_type: 'text/html',
          fallback_to_index: 1,
        },
      ]) as never,
      user,
      { id: 'site123abc', path: '/dashboard' },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toMatchObject({
      kind: 'html',
      artifactKind: 'static_site',
      path: '/index.html',
      fileName: 'index.html',
    })
    expect(getArtifactMock).toHaveBeenCalledWith(
      {},
      'ws1/site123abc/ver999/index.html',
    )
  })

  test('returns nested index html source for static site directory routes', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'site123abc',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver999',
      artifactKind: 'static_site',
      entrypointPath: '/index.html',
      r2Key: 'ws1/site123abc/ver999/index.html',
      isTeamWorkspaceAdmin: false,
    })
    getArtifactMock.mockResolvedValue({
      text: vi.fn().mockResolvedValue('<html><body>Docs</body></html>'),
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    })

    const result = await getExportSource(
      versionFileDb([
        {
          path: '/docs/index.html',
          r2_key: 'ws1/site123abc/ver999/docs/index.html',
          mime_type: 'text/html',
          fallback_to_index: 0,
        },
        {
          path: '/index.html',
          r2_key: 'ws1/site123abc/ver999/index.html',
          mime_type: 'text/html',
          fallback_to_index: 1,
        },
      ]) as never,
      user,
      { id: 'site123abc', path: '/docs/' },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toMatchObject({
      path: '/docs/index.html',
      fileName: 'index.html',
    })
    expect(getArtifactMock).toHaveBeenCalledWith(
      {},
      'ws1/site123abc/ver999/docs/index.html',
    )
  })

  test('returns decoded static site paths from version_files', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'site123abc',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver999',
      artifactKind: 'static_site',
      entrypointPath: '/index.html',
      r2Key: 'ws1/site123abc/ver999/index.html',
      isTeamWorkspaceAdmin: false,
    })
    getArtifactMock.mockResolvedValue({
      text: vi.fn().mockResolvedValue('<html><body>My Page</body></html>'),
      httpMetadata: { contentType: 'text/html; charset=utf-8' },
    })

    const result = await getExportSource(
      versionFileDb({
        path: '/docs/my page.html',
        r2_key: 'ws1/site123abc/ver999/docs/my page.html',
        mime_type: 'text/html',
      }) as never,
      user,
      { id: 'site123abc', path: '/docs/my%20page.html' },
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data).toMatchObject({
      path: '/docs/my page.html',
      fileName: 'my page.html',
    })
  })

  test('returns not-found when access is missing', async () => {
    loadCommentAccessMock.mockResolvedValue(null)

    const result = await getExportSource({} as never, user, { id: 'nope' })

    expect(result).toEqual({ kind: 'not-found' })
  })

  test('returns unsupported-kind for non-exportable artifact kinds', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'spa123abcd',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver123',
      artifactKind: 'spa',
      entrypointPath: '/index.html',
      r2Key: 'ws1/spa123abcd/ver123/index.html',
      isTeamWorkspaceAdmin: false,
    })

    const result = await getExportSource({} as never, user, {
      id: 'spa123abcd',
    })

    expect(result).toEqual({ kind: 'unsupported-kind', artifactKind: 'spa' })
  })

  test('returns non-html-source for static site paths that are not HTML', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'site123abc',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver999',
      artifactKind: 'static_site',
      entrypointPath: '/index.html',
      r2Key: 'ws1/site123abc/ver999/index.html',
      isTeamWorkspaceAdmin: false,
    })

    const result = await getExportSource(
      versionFileDb({
        path: '/assets/app.js',
        r2_key: 'ws1/site123abc/ver999/assets/app.js',
        mime_type: 'text/javascript',
      }) as never,
      user,
      { id: 'site123abc', path: '/assets/app.js' },
    )

    expect(result).toEqual({
      kind: 'non-html-source',
      path: '/assets/app.js',
      contentType: 'text/javascript',
    })
    expect(getArtifactMock).not.toHaveBeenCalled()
  })

  test('returns source-unavailable when the stored object is missing', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'abc123def4',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver123',
      artifactKind: 'markdown_page',
      entrypointPath: '/index.md',
      r2Key: 'ws1/abc123def4/ver123/index.md',
      isTeamWorkspaceAdmin: false,
    })
    getArtifactMock.mockResolvedValue(null)

    const result = await getExportSource({} as never, user, {
      id: 'abc123def4',
    })

    expect(result).toEqual({ kind: 'source-unavailable' })
  })
})

describe('getExportAsset', () => {
  beforeEach(() => {
    loadCommentAccessMock.mockReset()
    getArtifactMock.mockReset()
  })

  test('returns a static site asset by path', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'site123abc',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver999',
      artifactKind: 'static_site',
      entrypointPath: '/index.html',
      r2Key: 'ws1/site123abc/ver999/index.html',
      isTeamWorkspaceAdmin: false,
    })
    const object = {
      body: new ReadableStream(),
      text: vi.fn(),
      httpMetadata: { contentType: 'text/css' },
      size: 12,
      uploaded: new Date('2026-06-09T00:00:00.000Z'),
    }
    getArtifactMock.mockResolvedValue(object)

    const result = await getExportAsset(
      versionFileDb({
        path: '/assets/app.css',
        r2_key: 'ws1/site123abc/ver999/assets/app.css',
        mime_type: 'text/css',
      }) as never,
      user,
      { id: 'site123abc', path: '/assets/app.css' },
    )

    expect(result).toEqual({
      kind: 'ok',
      object,
      path: '/assets/app.css',
      contentType: 'text/css',
    })
  })

  test('returns unsupported-kind outside static sites', async () => {
    loadCommentAccessMock.mockResolvedValue({
      shareableId: 'html123abc',
      workspaceId: 'ws1',
      ownerUserId: 'owner1',
      visibility: 'private',
      currentVersionId: 'ver123',
      artifactKind: 'html_page',
      entrypointPath: '/demo.html',
      r2Key: 'ws1/html123abc/ver123/demo.html',
      isTeamWorkspaceAdmin: false,
    })

    const result = await getExportAsset({} as never, user, {
      id: 'html123abc',
      path: '/demo.html',
    })

    expect(result).toEqual({
      kind: 'unsupported-kind',
      artifactKind: 'html_page',
    })
  })
})

describe('exportSourceErrorResponse', () => {
  test('maps failure kinds to HTTP statuses', async () => {
    expect(
      (await exportSourceErrorResponse({ kind: 'not-found' }).json()) as {
        error: { code: string }
      },
    ).toMatchObject({ error: { code: 'not-found' } })
    expect(exportSourceErrorResponse({ kind: 'not-found' }).status).toBe(404)

    expect(
      exportSourceErrorResponse({
        kind: 'unsupported-kind',
        artifactKind: 'spa',
      }).status,
    ).toBe(400)

    expect(
      exportSourceErrorResponse({
        kind: 'non-html-source',
        path: '/assets/app.js',
        contentType: 'text/javascript',
      }).status,
    ).toBe(400)

    expect(
      exportSourceErrorResponse({ kind: 'source-unavailable' }).status,
    ).toBe(409)
  })
})

function versionFileDb(rowOrRows: unknown | unknown[]) {
  const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows]
  const row = rows[0] ?? null
  return {
    selectFrom: () => ({
      innerJoin: () => ({
        select: () => ({
          where: () => ({
            where: () => ({
              execute: vi.fn().mockResolvedValue(rows),
            }),
          }),
        }),
      }),
      select: () => ({
        where: () => ({
          where: () => ({
            executeTakeFirst: vi.fn().mockResolvedValue(row),
          }),
        }),
      }),
    }),
  }
}
