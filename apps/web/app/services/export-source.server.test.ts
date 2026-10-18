import { beforeEach, describe, expect, test, vi } from 'vitest'

const loadCommentAccessMock = vi.hoisted(() => vi.fn())
const getArtifactMock = vi.hoisted(() => vi.fn())
const routeDbMock = vi.hoisted(() => vi.fn())
vi.mock('~/services/db.server', () => ({ createDb: routeDbMock }))
vi.mock('~/middleware/auth', () => ({ requireUserApiMiddleware: vi.fn() }))
vi.mock('~/middleware/context', () => ({ requireUser: () => user }))

vi.mock('cloudflare:workers', () => ({
  env: { BUCKET: {} },
}))
vi.mock('~/services/comments.server', () => ({
  loadCommentAccess: loadCommentAccessMock,
}))
vi.mock('~/services/storage.server', () => ({
  getArtifact: getArtifactMock,
}))

import { loader as sourceLoader } from '~/routes/api.shareables.$id.export-source'
import { loader as assetLoader } from '~/routes/api.shareables.$id.export-asset.$'
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

    const result = await getExportSource(
      versionFileDb({ id: 'version-1' }) as never,
      user,
      {
        id: 'abc123def4',
      },
    )

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

    const result = await getExportSource(
      versionFileDb({ id: 'version-1' }) as never,
      user,
      {
        id: 'html123abc',
      },
    )

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

    const result = await getExportSource(
      versionFileDb({ id: 'version-1' }) as never,
      user,
      { id: 'nope' },
    )

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

    const result = await getExportSource(
      versionFileDb({ id: 'version-1' }) as never,
      user,
      {
        id: 'spa123abcd',
      },
    )

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

    const result = await getExportSource(
      versionFileDb({ id: 'version-1' }) as never,
      user,
      {
        id: 'abc123def4',
      },
    )

    expect(result).toEqual({ kind: 'source-unavailable' })
  })
})

describe('getExportAsset', () => {
  beforeEach(() => {
    loadCommentAccessMock.mockReset()
    getArtifactMock.mockReset()
  })

  test.each([null, '', 'old-version', 'foreign-version'])(
    'refuses missing or stale asset snapshot %s before storage',
    async (versionId) => {
      loadCommentAccessMock.mockResolvedValue({
        currentVersionId: 'version-1',
        artifactKind: 'static_site',
      })
      expect(
        await getExportAsset(
          versionFileDb({ id: 'version-1' }) as never,
          user,
          { id: 'artifact-1', path: '/a.png', versionId },
        ),
      ).toEqual({ kind: 'not-found' })
      expect(getArtifactMock).not.toHaveBeenCalled()
    },
  )

  test('refuses revoked source access and stale expected source versions', async () => {
    loadCommentAccessMock.mockResolvedValue({
      currentVersionId: 'version-2',
      artifactKind: 'html_page',
    })
    expect(
      await getExportSource(versionFileDb({ id: 'version-1' }) as never, user, {
        id: 'artifact-1',
        versionId: 'version-1',
      }),
    ).toEqual({ kind: 'not-found' })
    loadCommentAccessMock.mockResolvedValue(null)
    expect(
      await getExportSource(versionFileDb({ id: 'version-1' }) as never, user, {
        id: 'artifact-1',
        versionId: 'version-2',
      }),
    ).toEqual({ kind: 'not-found' })
    expect(getArtifactMock).not.toHaveBeenCalled()
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
      { id: 'site123abc', path: '/assets/app.css', versionId: 'ver999' },
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

    const result = await getExportAsset(
      versionFileDb({ id: 'version-1' }) as never,
      user,
      {
        id: 'html123abc',
        path: '/demo.html',
        versionId: 'ver123',
      },
    )

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
  const query = {
    innerJoin: () => query,
    select: () => query,
    where: (..._args: unknown[]) => query,
    execute: vi.fn().mockResolvedValue(rows),
    executeTakeFirst: vi.fn().mockResolvedValue(row),
  }
  return {
    selectFrom: (table: string) =>
      table === 'versions'
        ? {
            ...query,
            select: () => ({
              ...query,
              executeTakeFirst: vi.fn().mockResolvedValue({ id: 'version-1' }),
            }),
          }
        : query,
  }
}

test('refuses foreign version ownership before reading the source object', async () => {
  loadCommentAccessMock.mockResolvedValue({
    currentVersionId: 'foreign-version',
    artifactKind: 'html_page',
    r2Key: 'source',
  })
  getArtifactMock.mockClear()
  const query = {
    select: () => query,
    where: () => query,
    executeTakeFirst: vi.fn().mockResolvedValue(undefined),
  }
  expect(
    await getExportSource({ selectFrom: () => query } as never, user, {
      id: 'artifact-1',
      versionId: 'foreign-version',
    }),
  ).toEqual({ kind: 'not-found' })
  expect(getArtifactMock).not.toHaveBeenCalled()
})

test('rechecks access after reading snapshot bytes', async () => {
  loadCommentAccessMock.mockReset()
  loadCommentAccessMock
    .mockResolvedValueOnce({
      currentVersionId: 'version-1',
      artifactKind: 'html_page',
      r2Key: 'source',
    })
    .mockResolvedValueOnce(null)
  getArtifactMock.mockResolvedValue({
    text: async () => '<p>Old source</p>',
    httpMetadata: { contentType: 'text/html' },
  })
  expect(
    await getExportSource(versionFileDb({}) as never, user, {
      id: 'artifact-1',
      versionId: 'version-1',
    }),
  ).toEqual({ kind: 'not-found' })
})

test('asset lookup pins ownership, version and exact canonical path and rechecks a changed version', async () => {
  const where = vi.fn(() => query)
  const query = {
    innerJoin: () => query,
    select: () => query,
    where,
    executeTakeFirst: vi.fn().mockResolvedValue({
      path: '/images/a.png',
      r2_key: 'snapshot/image',
      mime_type: 'image/png',
    }),
  }
  loadCommentAccessMock.mockReset()
  loadCommentAccessMock
    .mockResolvedValueOnce({
      currentVersionId: 'version-1',
      artifactKind: 'static_site',
    })
    .mockResolvedValueOnce({ currentVersionId: 'version-2' })
  getArtifactMock.mockResolvedValue({
    body: new ReadableStream(),
    httpMetadata: { contentType: 'image/png' },
  })
  expect(
    await getExportAsset({ selectFrom: () => query } as never, user, {
      id: 'artifact-1',
      versionId: 'version-1',
      path: '/images/a.png',
    }),
  ).toEqual({ kind: 'not-found' })
  expect(where.mock.calls).toEqual([
    ['version_files.version_id', '=', 'version-1'],
    ['versions.shareable_id', '=', 'artifact-1'],
    ['version_files.path', '=', '/images/a.png'],
  ])
})

test.each(['markdown_page', 'html_page'])(
  'stored %s entrypoints preserve literal percent through initial load and snapshot revalidation',
  async (artifactKind) => {
    const path =
      artifactKind === 'markdown_page' ? '/growth 20%.md' : '/growth 20%.html'
    loadCommentAccessMock.mockResolvedValue({
      currentVersionId: 'version-1',
      artifactKind,
      entrypointPath: path,
      r2Key: 'artifact-1/version-1/source',
    })
    getArtifactMock.mockResolvedValue({
      text: async () => 'Report',
      httpMetadata: {
        contentType:
          artifactKind === 'markdown_page' ? 'text/markdown' : 'text/html',
      },
    })
    for (const query of [
      undefined,
      path.split('/').map(encodeURIComponent).join('/'),
    ]) {
      const result = await getExportSource(
        versionFileDb({ id: 'version-1' }) as never,
        user,
        { id: 'artifact-1', path: query, versionId: 'version-1' },
      )
      expect(result).toMatchObject({
        kind: 'ok',
        data: { path, versionId: 'version-1' },
      })
    }
  },
)

test('exact authorized asset lookup preserves a decoded literal percent name', async () => {
  loadCommentAccessMock.mockResolvedValue({
    currentVersionId: 'version-1',
    artifactKind: 'static_site',
  })
  getArtifactMock.mockResolvedValue({
    body: new Blob(['png']).stream(),
    httpMetadata: { contentType: 'image/png' },
  })
  const result = await getExportAsset(
    versionFileDb({
      path: '/growth 20%.png',
      r2_key: 'artifact-1/version-1/image',
      mime_type: 'image/png',
    }) as never,
    user,
    { id: 'artifact-1', versionId: 'version-1', path: '/growth 20%.png' },
  )
  expect(result).toMatchObject({ kind: 'ok', path: '/growth 20%.png' })
})

test.each([
  '/../image.png',
  '/a\\b.png',
  '/a/../image.png',
  '/a.png?x=1',
  '/a.png#x',
])(
  'decoded asset route rejects ambiguous path %s before storage',
  async (path) => {
    loadCommentAccessMock.mockResolvedValue({
      currentVersionId: 'version-1',
      artifactKind: 'static_site',
    })
    getArtifactMock.mockClear()
    expect(
      await getExportAsset(versionFileDb({}) as never, user, {
        id: 'artifact-1',
        versionId: 'version-1',
        path,
      }),
    ).toEqual({ kind: 'not-found' })
    expect(getArtifactMock).not.toHaveBeenCalled()
  },
)

test.each(
  ['markdown_page', 'html_page'].flatMap((artifactKind) =>
    ['growth 20%', 'Survey 30%Decline', 'literal%2e', 'literal%2f'].map(
      (name) => ({ artifactKind, name }),
    ),
  ),
)(
  'authorized source route exports stored percent entrypoint $name ($artifactKind) and refuses stale access',
  async ({ artifactKind, name }) => {
    const path =
      '/' + name + (artifactKind === 'markdown_page' ? '.md' : '.html')
    loadCommentAccessMock.mockReset().mockResolvedValue({
      currentVersionId: 'version-1',
      artifactKind,
      entrypointPath: path,
      r2Key: 'artifact-1/version-1/source',
    })
    routeDbMock.mockReturnValue(versionFileDb({ id: 'version-1' }))
    getArtifactMock.mockResolvedValue({
      text: async () => 'Report',
      httpMetadata: {
        contentType:
          artifactKind === 'markdown_page' ? 'text/markdown' : 'text/html',
      },
    })
    const url = new URL(
      'https://artifactshare.test/api/shareables/artifact-1/export-source',
    )
    url.searchParams.set(
      'path',
      path.split('/').map(encodeURIComponent).join('/'),
    )
    url.searchParams.set('versionId', 'version-1')
    const args = {
      context: new Map(),
      params: { id: 'artifact-1' },
      request: new Request(url),
      url,
    } as never
    const response = await sourceLoader(args)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      path,
      versionId: 'version-1',
    })
    loadCommentAccessMock.mockResolvedValue({
      currentVersionId: 'version-2',
      artifactKind,
    })
    expect((await sourceLoader(args)).status).toBe(404)
    loadCommentAccessMock.mockResolvedValue(null)
    expect((await sourceLoader(args)).status).toBe(404)
  },
)

test.each([
  'growth 20%.png',
  '100%ad.png',
  'literal%2e.md',
  'literal%2f.md',
  'literal%2F.png',
])(
  'authorized asset route resolves %s and rejects encoded path confusion',
  async (name) => {
    loadCommentAccessMock.mockReset().mockResolvedValue({
      currentVersionId: 'version-1',
      artifactKind: 'static_site',
    })
    const db = versionFileDb({
      path: '/' + name,
      r2_key: 'artifact-1/version-1/image',
      mime_type: 'image/png',
    })
    const where = vi.spyOn(db.selectFrom('version_files'), 'where')
    routeDbMock.mockReturnValue(db)
    getArtifactMock.mockResolvedValue({
      body: new Blob(['png']).stream(),
      size: 3,
      httpMetadata: { contentType: 'image/png' },
    })
    const url = new URL(
      `https://artifactshare.test/api/shareables/artifact-1/export-asset/${encodeURIComponent(name)}?versionId=version-1`,
    )
    const args = (path: string, requestUrl = url) =>
      ({
        context: new Map(),
        params: { id: 'artifact-1', '*': path },
        request: new Request(requestUrl),
        url: requestUrl,
      }) as never
    const response = await assetLoader(args(name))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('png')
    expect(where.mock.calls).toEqual([
      ['version_files.version_id', '=', 'version-1'],
      ['versions.shareable_id', '=', 'artifact-1'],
      ['version_files.path', '=', '/' + name],
    ])
    getArtifactMock.mockClear()
    for (const path of ['%2e%2e/image.png', 'a%2fb.png', 'a%5cb.png'])
      expect(
        (
          await assetLoader(
            args(
              path,
              new URL(
                `https://artifactshare.test/api/shareables/artifact-1/export-asset/${path}?versionId=version-1`,
              ),
            ),
          )
        ).status,
      ).toBe(404)
    expect(getArtifactMock).not.toHaveBeenCalled()
  },
)
