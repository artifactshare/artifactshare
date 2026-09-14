import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  parseProductFilter,
  updateOgDescription,
  updatesDetailMeta,
  updatesListMeta,
} from '~/lib/updates-meta'
import type { UpdateProduct } from '~/lib/updates-types'
import UpdatesRoute, { loader, meta, screen } from './_public/($locale)/updates'

const { getLatestVisibleNoticeMock, getVisibleUpdatesMock } = vi.hoisted(
  () => ({
    getLatestVisibleNoticeMock: vi.fn(),
    getVisibleUpdatesMock: vi.fn(),
  }),
)

vi.mock('~/services/updates-visibility.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getLatestVisibleNotice: getLatestVisibleNoticeMock,
  getVisibleUpdates: getVisibleUpdatesMock,
  getVisibleUpdateBySlug: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  env: { APP_ENV: 'development' },
}))

const sampleEntry = {
  slug: '2026-07-02-link-share-ogp',
  title: 'Link shares now show rich previews on social platforms',
  date: '2026-07-02',
  products: ['web'] as UpdateProduct[],
  kind: 'improve' as const,
  bodyHtml:
    '<p>Shared artifact links now include Open Graph images and descriptions when pasted into chat apps or social feeds.</p>',
  summaryHtml:
    '<p>Shared artifact links now include Open Graph images and descriptions when pasted into chat apps or social feeds.</p>',
  hasMore: false,
}

beforeEach(() => {
  getVisibleUpdatesMock.mockReset()
  getVisibleUpdatesMock.mockResolvedValue([sampleEntry])
  getLatestVisibleNoticeMock.mockReset()
  getLatestVisibleNoticeMock.mockResolvedValue({ slug: 'latest-notice' })
})

describe('parseProductFilter', () => {
  test('accepts known product values', () => {
    expect(parseProductFilter('cli')).toBe('cli')
  })

  test('ignores unknown values', () => {
    expect(parseProductFilter('unknown')).toBeUndefined()
    expect(parseProductFilter(null)).toBeUndefined()
  })
})

describe('/updates list meta', () => {
  test('uses language-specific canonical and hreflang links', () => {
    const en = updatesListMeta('en')
    const ja = updatesListMeta('ja')

    expect(en).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://artifactshare.com/updates',
    })
    expect(ja).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://artifactshare.com/ja/updates',
    })
    for (const tags of [en, ja]) {
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'en',
        href: 'https://artifactshare.com/updates',
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'ja',
        href: 'https://artifactshare.com/ja/updates',
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'x-default',
        href: 'https://artifactshare.com/updates',
      })
      expect(tags).toContainEqual({
        property: 'og:image',
        content: 'https://artifactshare.com/og-image',
      })
    }
  })
})

describe('/updates list loaders', () => {
  test('returns visible entries in English', async () => {
    const data = await loader({
      params: {},
      request: new Request('https://artifactshare.com/updates'),
    } as never)

    expect(getVisibleUpdatesMock).toHaveBeenCalledWith('en', undefined)
    expect(data.data).toStrictEqual({
      entries: [(({ bodyHtml: _bodyHtml, ...item }) => item)(sampleEntry)],
      product: undefined,
    })
    const cookie = new Headers(data.init?.headers).get('Set-Cookie')
    expect(cookie).toContain('latest-notice')
    expect(cookie).toContain('opened')
  })

  test('passes product filter to visibility loader', async () => {
    await loader({
      params: {},
      request: new Request('https://artifactshare.com/updates?product=cli'),
    } as never)

    expect(getVisibleUpdatesMock).toHaveBeenCalledWith('en', 'cli')
  })

  test('ignores invalid product filter', async () => {
    await loader({
      params: {},
      request: new Request('https://artifactshare.com/updates?product=nope'),
    } as never)

    expect(getVisibleUpdatesMock).toHaveBeenCalledWith('en', undefined)
  })

  test('returns visible entries in Japanese', async () => {
    const data = await loader({
      params: { locale: 'ja' },
      request: new Request('https://artifactshare.com/ja/updates'),
    } as never)

    expect(getVisibleUpdatesMock).toHaveBeenCalledWith('ja', undefined)
    expect(data.data).toStrictEqual({
      entries: [(({ bodyHtml: _bodyHtml, ...item }) => item)(sampleEntry)],
      product: undefined,
    })
  })

  test('returns 404 for an unsupported locale segment', async () => {
    await expect(
      loader({
        params: { locale: 'fr' },
        request: new Request('https://artifactshare.com/fr/updates'),
      } as never),
    ).rejects.toMatchObject({ status: 404 })
    expect(getVisibleUpdatesMock).not.toHaveBeenCalled()
  })
})

describe('locale-aware updates list metadata', () => {
  test('preserves the existing English and Japanese list URLs', () => {
    expect(screen.route).toEqual({
      en: '/updates',
      ja: '/ja/updates',
    })
  })

  test.each([
    {
      locale: 'en' as const,
      canonical: 'https://artifactshare.com/updates',
      title: 'Updates · Artifact Share',
      description:
        'Recent improvements and changes to Artifact Share for Web, CLI, MCP, and AI agent workflows.',
    },
    {
      locale: 'ja' as const,
      canonical: 'https://artifactshare.com/ja/updates',
      title: '更新情報 · Artifact Share',
      description:
        'Artifact Share の Web、CLI、MCP、AI エージェント向け機能の改善と変更をお知らせします。',
    },
  ])(
    '$canonical keeps its locale metadata',
    ({ locale, canonical, title, description }) => {
      const params = locale === 'ja' ? { locale } : {}
      const loaderData = { entries: [], product: undefined }
      const tags = meta({ params, loaderData } as never)
      expect(UpdatesRoute({ params, loaderData } as never).props).toEqual({
        locale,
        ...loaderData,
      })

      expect(tags).toEqual(
        expect.arrayContaining([
          { title },
          { name: 'description', content: description },
          {
            tagName: 'link',
            rel: 'canonical',
            href: canonical,
          },
          {
            tagName: 'link',
            rel: 'alternate',
            hrefLang: 'en',
            href: 'https://artifactshare.com/updates',
          },
          {
            tagName: 'link',
            rel: 'alternate',
            hrefLang: 'ja',
            href: 'https://artifactshare.com/ja/updates',
          },
          {
            tagName: 'link',
            rel: 'alternate',
            hrefLang: 'x-default',
            href: 'https://artifactshare.com/updates',
          },
          { property: 'og:url', content: canonical },
          {
            property: 'og:image',
            content: 'https://artifactshare.com/og-image',
          },
          { name: 'twitter:title', content: title },
          { name: 'twitter:description', content: description },
          {
            name: 'twitter:image',
            content: 'https://artifactshare.com/og-image',
          },
        ]),
      )
    },
  )
})

describe('updateOgDescription', () => {
  test('strips HTML and truncates long descriptions', () => {
    const description = updateOgDescription(
      '<p>One</p><p>Two</p><p>' + 'x'.repeat(200) + '</p>',
      40,
    )
    expect(description.startsWith('One Two ')).toBe(true)
    expect(description.endsWith('…')).toBe(true)
    expect(description.length).toBeLessThanOrEqual(41)
  })
})

describe('/updates detail meta', () => {
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
    'uses locale-specific canonical and slug OG image ($locale)',
    ({ locale, canonical, ogImage }) => {
      const tags = updatesDetailMeta(sampleEntry, locale)

      expect(tags).toContainEqual({
        property: 'og:title',
        content: sampleEntry.title,
      })
      expect(tags).toContainEqual({
        property: 'og:image',
        content: ogImage,
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'canonical',
        href: canonical,
      })
      expect(tags).toContainEqual({
        'script:ld+json': {
          '@context': 'https://schema.org',
          '@type': 'BlogPosting',
          headline: sampleEntry.title,
          datePublished: sampleEntry.date,
          inLanguage: locale,
        },
      })
      expect(tags).toContainEqual({ property: 'og:url', content: canonical })
      expect(tags).toContainEqual({
        name: 'twitter:title',
        content: sampleEntry.title,
      })
      expect(tags).toContainEqual({ name: 'twitter:image', content: ogImage })
    },
  )
})
