import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  assetRouteHref,
  containsAppOriginCssUrl,
  containsUnsafeCssUrl,
  fetchExportSource,
  isAppOriginPrintUrl,
  isRootRelativeAssetRef,
  isSafePrintUrl,
  markdownDownloadFileName,
  normalizeExportPath,
  normalizeReadabilityUrls,
  normalizeStaticSiteFramePath,
  stripAppOriginSrcset,
  sanitizePrintSrcset,
  sourceDirectory,
  splitAssetRef,
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

  test('assetRouteHref encodes static site asset paths', () => {
    expect(
      assetRouteHref('abc123', '/assets/logo.png', 'https://example.com'),
    ).toBe(
      'https://example.com/api/shareables/abc123/export-asset/assets/logo.png',
    )
  })

  test('splitAssetRef preserves query and hash suffixes', () => {
    expect(splitAssetRef('/a.css?v=1#frag')).toEqual({
      pathname: '/a.css',
      suffix: '?v=1#frag',
    })
  })

  test('isRootRelativeAssetRef accepts root-relative refs only', () => {
    expect(isRootRelativeAssetRef('/assets/a.png')).toBe(true)
    expect(isRootRelativeAssetRef('//cdn.example/a.png')).toBe(false)
    expect(isRootRelativeAssetRef('https://example.com/a.png')).toBe(false)
    expect(isRootRelativeAssetRef('mailto:hi@example.com')).toBe(false)
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

  test('print URL sanitizer rejects active schemes', () => {
    expect(isSafePrintUrl('https://example.com/')).toBe(true)
    expect(isSafePrintUrl('/assets/image.png')).toBe(true)
    expect(isSafePrintUrl('data:image/png;base64,aaa')).toBe(true)
    expect(isSafePrintUrl('java\nscript:alert(1)')).toBe(false)
    expect(isSafePrintUrl('data:text/html,<script>alert(1)</script>')).toBe(
      false,
    )
    expect(sanitizePrintSrcset('/safe.png 1x, javascript:alert(1) 2x')).toBe(
      '/safe.png 1x',
    )
    expect(containsUnsafeCssUrl('background: url(javascript:alert(1))')).toBe(
      true,
    )
  })

  test('app-origin print URL sanitizer keeps relative refs inert', () => {
    const appOrigin = 'https://artifactshare.test'

    expect(isAppOriginPrintUrl('/api/me', appOrigin)).toBe(false)
    expect(isAppOriginPrintUrl('assets/image.png', appOrigin)).toBe(false)
    expect(
      isAppOriginPrintUrl('https://artifactshare.test/api/me', appOrigin),
    ).toBe(true)
    expect(isAppOriginPrintUrl('//artifactshare.test/api/me', appOrigin)).toBe(
      true,
    )
    expect(
      stripAppOriginSrcset(
        'https://artifactshare.test/a.png 1x, https://cdn.example/a.png 2x',
        appOrigin,
      ),
    ).toBe('https://cdn.example/a.png 2x')
    expect(
      containsAppOriginCssUrl(
        'background: url("https://artifactshare.test/api/me")',
        appOrigin,
      ),
    ).toBe(true)
  })
})
