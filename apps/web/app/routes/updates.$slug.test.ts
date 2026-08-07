import { beforeEach, describe, expect, test, vi } from 'vitest'

import { loader } from './updates.$slug'
import { loader as jaLoader } from './ja.updates.$slug'

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
    expect(data.data).toEqual({ entry: detail })
    const cookie = new Headers(data.init?.headers).get('Set-Cookie')
    expect(cookie).toContain('latest-notice')
    expect(cookie).toContain('opened')
  })

  test('returns the visible entry in Japanese', async () => {
    getVisibleUpdateBySlugMock.mockResolvedValue(sampleEntry)

    const data = await jaLoader({
      params: { slug: sampleEntry.slug },
      request: new Request(
        'https://artifactshare.com/ja/updates/' + sampleEntry.slug,
      ),
    } as never)

    expect(getVisibleUpdateBySlugMock).toHaveBeenCalledWith(
      sampleEntry.slug,
      'ja',
    )
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
