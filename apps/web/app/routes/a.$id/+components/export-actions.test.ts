import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  fetchExportSource,
  markdownDownloadFileName,
  normalizeExportPath,
  normalizeReadabilityUrls,
  normalizeStaticSiteFramePath,
  sourceDirectory,
} from './export-actions'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('export-actions helpers', () => {
  test('normalizeExportPath defaults empty paths', () => {
    expect(normalizeExportPath('', '/index.html')).toBe('/index.html')
    expect(normalizeExportPath('/', '/index.html')).toBe('/index.html')
    expect(normalizeExportPath('notes/page.html')).toBe('/notes/page.html')
    expect(normalizeExportPath('/notes/page.html?q=1#top')).toBe(
      '/notes/page.html',
    )
  })

  test('normalizeStaticSiteFramePath maps root to index.html', () => {
    expect(normalizeStaticSiteFramePath('/')).toBe('/index.html')
    expect(normalizeStaticSiteFramePath('/about.html')).toBe('/about.html')
  })

  test('normalizeStaticSiteFramePath decodes browser pathnames', () => {
    expect(normalizeStaticSiteFramePath('/docs/my%20page.html')).toBe(
      '/docs/my page.html',
    )
  })

  test('markdownDownloadFileName replaces extension with .md', () => {
    expect(markdownDownloadFileName('report.html')).toBe('report.md')
    expect(markdownDownloadFileName('notes')).toBe('notes.md')
  })

  test('normalizeReadabilityUrls strips temporary base origin', () => {
    const markdown = 'See [home](https://artifactshare.local/docs/page.html).'
    expect(normalizeReadabilityUrls(markdown, '/docs/page.html')).toBe(
      'See [home](page.html).',
    )
  })

  test('sourceDirectory keeps trailing slash directory', () => {
    expect(sourceDirectory('/docs/page.html')).toBe('/docs/')
    expect(sourceDirectory('/index.html')).toBe('/')
  })

  test('fetchExportSource maps structured unsupported-kind errors', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'https://artifactshare.test' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: 'unsupported-kind',
              message: 'This artifact kind does not support export.',
            },
          },
          { status: 400 },
        ),
      ),
    )

    await expect(fetchExportSource('abc123', '/index.html')).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    })
  })
})

test('source revalidation pins the version, bypasses cache and refuses a replaced snapshot', async () => {
  vi.stubGlobal('window', {
    location: { origin: 'https://artifactshare.test' },
  })
  const fetch = vi.fn().mockResolvedValue(
    Response.json({
      kind: 'html',
      artifactKind: 'html_page',
      path: '/index.html',
      versionId: 'version-2',
      source: '<p>New source</p>',
      fileName: 'index.html',
    }),
  )
  vi.stubGlobal('fetch', fetch)
  expect(
    await fetchExportSource('artifact-1', '/guide/report.html', 'version-1'),
  ).toEqual({ ok: false, reason: 'failed' })
  const [url, init] = fetch.mock.calls[0]
  expect(url.searchParams.get('versionId')).toBe('version-1')
  expect(url.searchParams.get('path')).toBe('/guide/report.html')
  expect(init).toMatchObject({ cache: 'no-store', redirect: 'error' })
})

test.each([400, 401, 403, 404, 409, 500])(
  'unknown source failure %s retains the failed result',
  async (status) => {
    vi.stubGlobal('window', {
      location: { origin: 'https://artifactshare.test' },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not JSON', { status })),
    )
    expect(await fetchExportSource('artifact-1', '/index.html')).toEqual({
      ok: false,
      reason: 'failed',
    })
  },
)

test.each([undefined, 'version-1'])(
  'source acquisition encodes stored percent names once (version %s)',
  async (versionId) => {
    vi.stubGlobal('window', {
      location: { origin: 'https://artifactshare.test' },
    })
    const fetch = vi.fn().mockResolvedValue(new Response('', { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    await fetchExportSource('artifact-1', '/growth 20%.md', versionId)
    expect(fetch.mock.calls[0][0].searchParams.get('path')).toBe(
      '/growth%2020%25.md',
    )
  },
)

test.each(['/a%2fb.html', '/%2e%2e/a.html', '/a%5cb.html'])(
  'ambiguous frame path %s cannot select a different literal stored filename',
  (path) => {
    expect(normalizeStaticSiteFramePath(path)).toBeNull()
  },
)

test.each(['literal%2f.html', 'literal%2e.html', 'literal%.html'])(
  'frame paths decode literal stored name %s exactly once',
  (name) => {
    expect(normalizeStaticSiteFramePath('/' + encodeURIComponent(name))).toBe(
      '/' + name,
    )
  },
)
