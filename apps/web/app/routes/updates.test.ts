import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  parseProductFilter,
  updateOgDescription,
  updatesDetailMeta,
  updatesListMeta,
} from '~/lib/updates-meta'
import type { UpdateProduct } from '~/lib/updates-types'
import { loader } from './updates'
import { loader as jaLoader } from './ja.updates'

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
      request: new Request('https://artifactshare.com/updates'),
    } as never)

    expect(getVisibleUpdatesMock).toHaveBeenCalledWith('en', undefined)
    expect(data.data.entries).toEqual([
      (({ bodyHtml: _bodyHtml, ...item }) => item)(sampleEntry),
    ])
    const cookie = new Headers(data.init?.headers).get('Set-Cookie')
    expect(cookie).toContain('latest-notice')
    expect(cookie).toContain('opened')
  })

  test('passes product filter to visibility loader', async () => {
    await loader({
      request: new Request('https://artifactshare.com/updates?product=cli'),
    } as never)

    expect(getVisibleUpdatesMock).toHaveBeenCalledWith('en', 'cli')
  })

  test('ignores invalid product filter', async () => {
    await loader({
      request: new Request('https://artifactshare.com/updates?product=nope'),
    } as never)

    expect(getVisibleUpdatesMock).toHaveBeenCalledWith('en', undefined)
  })

  test('Japanese loader returns ja locale', async () => {
    const data = await jaLoader({
      request: new Request('https://artifactshare.com/ja/updates'),
    } as never)

    expect(getVisibleUpdatesMock).toHaveBeenCalledWith('ja', undefined)
    expect(data.data.entries).toHaveLength(1)
  })
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
  test('uses entry title, generated description, and slug OG image', () => {
    const meta = updatesDetailMeta(sampleEntry, 'en')

    expect(meta).toContainEqual({
      property: 'og:title',
      content: sampleEntry.title,
    })
    expect(meta).toContainEqual({
      property: 'og:image',
      content:
        'https://artifactshare.com/updates/2026-07-02-link-share-ogp/og-image',
    })
    expect(meta).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://artifactshare.com/updates/2026-07-02-link-share-ogp',
    })
    expect(meta).toContainEqual({
      'script:ld+json': {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: sampleEntry.title,
        datePublished: sampleEntry.date,
        inLanguage: 'en',
      },
    })
  })
})
