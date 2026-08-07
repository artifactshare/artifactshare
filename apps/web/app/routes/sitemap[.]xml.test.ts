import { beforeEach, describe, expect, test, vi } from 'vitest'

import { escapeXml, loader } from './sitemap[.]xml'

const getVisibleUpdatesMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/updates-visibility.server', () => ({
  getVisibleUpdates: getVisibleUpdatesMock,
}))

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

beforeEach(() => {
  getVisibleUpdatesMock.mockReset()
  getVisibleUpdatesMock.mockResolvedValue([
    {
      slug: '2026-07-02-link-share-ogp',
      title: 'Link shares now show rich previews on social platforms',
      date: '2026-07-02',
      products: ['web'],
      kind: 'improve',
      bodyHtml: '<p>Body</p>',
      summaryHtml: '<p>Summary</p>',
      hasMore: false,
    },
  ])
})

describe('/sitemap.xml route', () => {
  test('includes localized root entries with all alternates exactly once', async () => {
    const response = await loader()
    const body = await response.text()
    for (const root of [
      'https://artifactshare.com/',
      'https://artifactshare.com/ja',
    ]) {
      const entry = body.slice(
        body.indexOf(`<loc>${root}</loc>`),
        body.indexOf('</url>', body.indexOf(`<loc>${root}</loc>`)),
      )
      expect(entry).toContain('hreflang="en" href="https://artifactshare.com/"')
      expect(entry).toContain(
        'hreflang="ja" href="https://artifactshare.com/ja"',
      )
      expect(entry).toContain(
        'hreflang="x-default" href="https://artifactshare.com/"',
      )
    }
    expect(
      body.match(/<loc>https:\/\/artifactshare\.com\/<\/loc>/g),
    ).toHaveLength(1)
    expect(
      body.match(/<loc>https:\/\/artifactshare\.com\/ja<\/loc>/g),
    ).toHaveLength(1)
  })

  test('includes updates list and visible detail pages with hreflang', async () => {
    const response = await loader()
    const body = await response.text()

    expect(body).toContain('<loc>https://artifactshare.com/updates</loc>')
    expect(body).toContain('<loc>https://artifactshare.com/ja/updates</loc>')
    expect(body).toContain('<loc>https://artifactshare.com/about</loc>')
    expect(body).toContain('<loc>https://artifactshare.com/ja/about</loc>')
    expect(body).toContain('<loc>https://artifactshare.com/start</loc>')
    expect(body).toContain('<loc>https://artifactshare.com/ja/start</loc>')
    expect(body).toContain('<loc>https://artifactshare.com/guides/cli</loc>')
    expect(body).toContain('<loc>https://artifactshare.com/ja/guides/cli</loc>')
    expect(body).toContain(
      '<loc>https://artifactshare.com/guides/workspace-owner</loc>',
    )
    expect(body).toContain(
      '<loc>https://artifactshare.com/ja/guides/workspace-admin</loc>',
    )
    expect(body).toContain(
      '<loc>https://artifactshare.com/guides/link-sharing</loc>',
    )
    expect(body).toContain(
      '<loc>https://artifactshare.com/ja/guides/link-sharing</loc>',
    )
    expect(body).toContain(
      '<loc>https://artifactshare.com/guides/private-mobile-design-handoff</loc>',
    )
    expect(body).toContain(
      '<loc>https://artifactshare.com/ja/guides/private-mobile-design-handoff</loc>',
    )
    expect(body).toContain(
      'hreflang="en" href="https://artifactshare.com/guides/private-mobile-design-handoff"',
    )
    expect(body).toContain(
      'hreflang="ja" href="https://artifactshare.com/ja/guides/private-mobile-design-handoff"',
    )
    expect(body).toContain(
      'hreflang="x-default" href="https://artifactshare.com/guides/private-mobile-design-handoff"',
    )
    expect(body).toContain(
      '<loc>https://artifactshare.com/updates/2026-07-02-link-share-ogp</loc>',
    )
    expect(body).toContain(
      '<loc>https://artifactshare.com/ja/updates/2026-07-02-link-share-ogp</loc>',
    )
    expect(body).toContain(
      'hreflang="en" href="https://artifactshare.com/updates/2026-07-02-link-share-ogp"',
    )
    expect(body).toContain(
      'hreflang="ja" href="https://artifactshare.com/ja/updates/2026-07-02-link-share-ogp"',
    )
    const updateEnEntry = body.slice(
      body.indexOf(
        '<loc>https://artifactshare.com/updates/2026-07-02-link-share-ogp</loc>',
      ),
      body.indexOf(
        '</url>',
        body.indexOf(
          '<loc>https://artifactshare.com/updates/2026-07-02-link-share-ogp</loc>',
        ),
      ),
    )
    const updateJaEntry = body.slice(
      body.indexOf(
        '<loc>https://artifactshare.com/ja/updates/2026-07-02-link-share-ogp</loc>',
      ),
      body.indexOf(
        '</url>',
        body.indexOf(
          '<loc>https://artifactshare.com/ja/updates/2026-07-02-link-share-ogp</loc>',
        ),
      ),
    )
    expect(updateEnEntry).toContain('<lastmod>2026-07-02</lastmod>')
    expect(updateJaEntry).toContain('<lastmod>2026-07-02</lastmod>')
    expect(body).not.toContain('hidden-entry')
    expect(getVisibleUpdatesMock).toHaveBeenCalledWith('en')
  })

  test('escapes XML values', async () => {
    const response = await loader()
    const body = await response.text()

    expect(escapeXml('<&>' + '"' + "'")).toBe('&lt;&amp;&gt;&quot;&apos;')
    expect(body).toContain('<loc>https://artifactshare.com/</loc>')
  })

  test('does not add lastmod to static pages', async () => {
    const response = await loader()
    const body = await response.text()
    const aboutEntry = body.slice(
      body.indexOf('<loc>https://artifactshare.com/about</loc>'),
      body.indexOf(
        '</url>',
        body.indexOf('<loc>https://artifactshare.com/about</loc>'),
      ),
    )

    expect(aboutEntry).not.toContain('<lastmod>')

    const rootEntry = body.slice(
      body.indexOf('<loc>https://artifactshare.com/</loc>'),
      body.indexOf(
        '</url>',
        body.indexOf('<loc>https://artifactshare.com/</loc>'),
      ),
    )
    expect(rootEntry).not.toContain('<lastmod>')
  })
})
