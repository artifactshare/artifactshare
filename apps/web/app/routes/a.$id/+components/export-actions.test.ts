import { afterEach, describe, expect, test, vi } from 'vitest'
import * as exportActions from './export-actions'
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
  test('exposes text downloads without a print or PDF entry point', () => {
    expect(exportActions.downloadText).toBeTypeOf('function')
    expect(
      Object.keys(exportActions).filter((name) => /print|pdf/i.test(name)),
    ).toEqual([])
  })

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
