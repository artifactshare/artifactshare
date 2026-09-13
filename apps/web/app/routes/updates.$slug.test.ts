import { beforeEach, describe, expect, test, vi } from 'vitest'

import { loader, meta, screen } from './_public/($locale)/updates.$slug'

const { getLatestVisibleNoticeMock, getVisibleUpdateBySlugMock } = vi.hoisted(
  () => ({
    getLatestVisibleNoticeMock: vi.fn(),
    getVisibleUpdateBySlugMock: vi.fn(),
  }),
)

vi.mock('~/services/updates-visibility.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLatestVisibleNotice: getLatestVisibleNoticeMock,
  getVisibleUpdates: vi.fn(),
  getVisibleUpdateBySlug: getVisibleUpdateBySlugMock,
}))

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

const sampleEntry = {
  slug: '2026-07-02-link-share-ogp',
  title: 'Link shares now show rich previews on social platforms',
  date: '2026-07-02',
  products: ['web'] as const,
  kind: 'improve' as const,
  bodyHtml: '<p>Body</p>',
  summaryHtml: '<p>Summary</p>',
  hasMore: false,
}

beforeEach(() => {
  getVisibleUpdateBySlugMock.mockReset()
  getLatestVisibleNoticeMock.mockReset()
  getLatestVisibleNoticeMock.mockResolvedValue({ slug: 'latest-notice' })
})

describe('/updates/:slug loaders', () => {
  test('returns the visible entry in English', async () => {
    getVisibleUpdateBySlugMock.mockResolvedValue(sampleEntry)

    const data = await loader({
      params: { slug: sampleEntry.slug },
      request: new Request(
        'https://artifactshare.com/updates/' + sampleEntry.slug,
      ),
    } as never)

    expect(getVisibleUpdateBySlugMock).toHaveBeenCalledWith(
      sampleEntry.slug,
      'en',
    )
    const { summaryHtml: _s, hasMore: _h, ...detail } = sampleEntry
    expect(data.data).toEqual({ locale: 'en', entry: detail })
    const cookie = new Headers(data.init?.headers).get('Set-Cookie')
    expect(cookie).toContain('latest-notice')
    expect(cookie).toContain('opened')
  })

  test('returns the visible entry in Japanese', async () => {
    getVisibleUpdateBySlugMock.mockResolvedValue(sampleEntry)

    const data = await loader({
      params: { locale: 'ja', slug: sampleEntry.slug },
      request: new Request(
        'https://artifactshare.com/ja/updates/' + sampleEntry.slug,
      ),
    } as never)

    expect(getVisibleUpdateBySlugMock).toHaveBeenCalledWith(
      sampleEntry.slug,
      'ja',
    )
    expect(data.data.locale).toBe('ja')
    expect(data.data.entry.slug).toBe(sampleEntry.slug)
  })

  test('throws 404 for unknown slug', async () => {
    getVisibleUpdateBySlugMock.mockResolvedValue(undefined)

    await expect(
      loader({ params: { slug: 'missing-slug' } } as never),
    ).rejects.toMatchObject({ status: 404 })
  })

  test('throws 404 for hidden flagged entry', async () => {
    getVisibleUpdateBySlugMock.mockResolvedValue(undefined)

    await expect(
      loader({ params: { slug: 'hidden-entry' } } as never),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('locale-aware updates detail metadata', () => {
  test('preserves the existing English and Japanese detail URL shapes', () => {
    expect(screen.route).toEqual({
      en: '/updates/{seed:update}',
      ja: '/ja/updates/{seed:update}',
    })
  })

  test.each([
    {
      locale: 'en' as const,
      canonical: 'https://artifactshare.com/updates/2026-07-02-link-share-ogp',
      ogImage:
        'https://artifactshare.com/updates/2026-07-02-link-share-ogp/og-image',
    },
    {
      locale: 'ja' as const,
      canonical:
        'https://artifactshare.com/ja/updates/2026-07-02-link-share-ogp',
      ogImage:
        'https://artifactshare.com/ja/updates/2026-07-02-link-share-ogp/og-image',
    },
  ])(
    'publishes canonical, JSON-LD, and social tags for $locale',
    ({ locale, canonical, ogImage }) => {
      const tags = meta({
        loaderData: { locale, entry: sampleEntry },
      } as never)

      expect(tags).toEqual(
        expect.arrayContaining([
          { title: `${sampleEntry.title} · Artifact Share` },
          { name: 'description', content: 'Body' },
          {
            tagName: 'link',
            rel: 'canonical',
            href: canonical,
          },
          {
            tagName: 'link',
            rel: 'alternate',
            hrefLang: 'en',
            href: 'https://artifactshare.com/updates/2026-07-02-link-share-ogp',
          },
          {
            tagName: 'link',
            rel: 'alternate',
            hrefLang: 'ja',
            href: 'https://artifactshare.com/ja/updates/2026-07-02-link-share-ogp',
          },
          {
            tagName: 'link',
            rel: 'alternate',
            hrefLang: 'x-default',
            href: 'https://artifactshare.com/updates/2026-07-02-link-share-ogp',
          },
          {
            'script:ld+json': {
              '@context': 'https://schema.org',
              '@type': 'BlogPosting',
              headline: sampleEntry.title,
              datePublished: sampleEntry.date,
              inLanguage: locale,
            },
          },
          { property: 'og:url', content: canonical },
          { property: 'og:image', content: ogImage },
          { name: 'twitter:title', content: sampleEntry.title },
          { name: 'twitter:description', content: 'Body' },
          { name: 'twitter:image', content: ogImage },
        ]),
      )
    },
  )
})
