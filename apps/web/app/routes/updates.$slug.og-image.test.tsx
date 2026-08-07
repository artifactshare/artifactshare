import { beforeEach, describe, expect, test, vi } from 'vitest'

const getVisibleUpdateBySlugMock = vi.hoisted(() => vi.fn())
const fetchUpdatesEntryOgImageMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/updates-visibility.server', () => ({
  getVisibleUpdateBySlug: getVisibleUpdateBySlugMock,
}))
vi.mock('~/services/og-image-worker.server', () => ({
  fetchUpdatesEntryOgImage: fetchUpdatesEntryOgImageMock,
}))

import { loader } from './updates.$slug.og-image'
import { loader as jaLoader } from './ja.updates.$slug.og-image'

const pngResponse = new Response(new Uint8Array([137, 80, 78, 71]), {
  headers: { 'content-type': 'image/png' },
})

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
  vi.clearAllMocks()
  fetchUpdatesEntryOgImageMock.mockResolvedValue(pngResponse)
})

describe('/updates/:slug/og-image loaders', () => {
  test('renders an Open Graph image for a visible entry in English', async () => {
    getVisibleUpdateBySlugMock.mockResolvedValue(sampleEntry)

    const response = await loader({
      params: { slug: sampleEntry.slug },
    })

    expect(response).toBe(pngResponse)
    expect(getVisibleUpdateBySlugMock).toHaveBeenCalledWith(
      sampleEntry.slug,
      'en',
    )
    expect(fetchUpdatesEntryOgImageMock).toHaveBeenCalledWith(
      sampleEntry.title,
      'en',
      sampleEntry.slug,
    )
  })

  test('renders an Open Graph image for a visible entry in Japanese', async () => {
    getVisibleUpdateBySlugMock.mockResolvedValue(sampleEntry)

    const response = await jaLoader({
      params: { slug: sampleEntry.slug },
    })

    expect(response).toBe(pngResponse)
    expect(getVisibleUpdateBySlugMock).toHaveBeenCalledWith(
      sampleEntry.slug,
      'ja',
    )
    expect(fetchUpdatesEntryOgImageMock).toHaveBeenCalledWith(
      sampleEntry.title,
      'ja',
      sampleEntry.slug,
    )
  })

  test('returns 404 for unknown slug', async () => {
    getVisibleUpdateBySlugMock.mockResolvedValue(undefined)

    await expect(
      loader({ params: { slug: 'missing-slug' } }),
    ).rejects.toMatchObject({ status: 404 })
    expect(fetchUpdatesEntryOgImageMock).not.toHaveBeenCalled()
  })

  test('returns 404 for hidden flagged entry', async () => {
    getVisibleUpdateBySlugMock.mockResolvedValue(undefined)

    await expect(
      loader({ params: { slug: 'hidden-entry' } }),
    ).rejects.toMatchObject({ status: 404 })
    expect(fetchUpdatesEntryOgImageMock).not.toHaveBeenCalled()
  })

  test('returns 404 when slug param is missing', async () => {
    await expect(loader({ params: {} })).rejects.toMatchObject({ status: 404 })
    expect(getVisibleUpdateBySlugMock).not.toHaveBeenCalled()
    expect(fetchUpdatesEntryOgImageMock).not.toHaveBeenCalled()
  })
})
