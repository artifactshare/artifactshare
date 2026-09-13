import { describe, expect, test, vi } from 'vitest'

const { fetchConnectOgImageMock } = vi.hoisted(() => ({
  fetchConnectOgImageMock: vi.fn(),
}))

vi.mock('~/services/og-image-worker.server', () => ({
  fetchConnectOgImage: fetchConnectOgImageMock,
}))

import { loader } from './_public/($locale)/connect.og-image'

describe('locale-aware connect OG route', () => {
  test('delegates both stable URL locales to the matching worker request', async () => {
    const enResponse = new Response('en')
    const jaResponse = new Response('ja')
    fetchConnectOgImageMock
      .mockResolvedValueOnce(enResponse)
      .mockResolvedValueOnce(jaResponse)

    await expect(loader({ params: {} } as never)).resolves.toBe(enResponse)
    await expect(loader({ params: { locale: 'ja' } } as never)).resolves.toBe(
      jaResponse,
    )
    expect(fetchConnectOgImageMock).toHaveBeenNthCalledWith(1, 'en')
    expect(fetchConnectOgImageMock).toHaveBeenNthCalledWith(2, 'ja')
  })
})
