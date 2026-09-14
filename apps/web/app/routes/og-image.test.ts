import { describe, expect, test, vi } from 'vitest'

const { fetchHomeOgImageMock } = vi.hoisted(() => ({
  fetchHomeOgImageMock: vi.fn(),
}))

vi.mock('~/services/og-image-worker.server', () => ({
  fetchHomeOgImage: fetchHomeOgImageMock,
}))

import { loader } from './_public/($locale)/og-image'

describe('locale-aware home OG route', () => {
  test('delegates both stable URL locales to the matching worker request', async () => {
    const enResponse = new Response('en')
    const jaResponse = new Response('ja')
    fetchHomeOgImageMock
      .mockResolvedValueOnce(enResponse)
      .mockResolvedValueOnce(jaResponse)

    await expect(loader({ params: {} } as never)).resolves.toBe(enResponse)
    await expect(loader({ params: { locale: 'ja' } } as never)).resolves.toBe(
      jaResponse,
    )
    expect(fetchHomeOgImageMock).toHaveBeenNthCalledWith(1, 'en')
    expect(fetchHomeOgImageMock).toHaveBeenNthCalledWith(2, 'ja')
  })
})
