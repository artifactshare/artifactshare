import { describe, expect, test, vi } from 'vitest'

const fetchPrivateMobileDesignHandoffOgImageMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/og-image-worker.server', () => ({
  fetchPrivateMobileDesignHandoffOgImage:
    fetchPrivateMobileDesignHandoffOgImageMock,
}))

import { loader } from './_public/($locale)/guides.private-mobile-design-handoff.og-image'

describe('private mobile design handoff OGP routes', () => {
  test('delegates each locale to the matching worker request', async () => {
    const enResponse = new Response('en')
    const jaResponse = new Response('ja')
    fetchPrivateMobileDesignHandoffOgImageMock
      .mockResolvedValueOnce(enResponse)
      .mockResolvedValueOnce(jaResponse)

    await expect(loader({ params: {} } as never)).resolves.toBe(enResponse)
    await expect(loader({ params: { locale: 'ja' } } as never)).resolves.toBe(
      jaResponse,
    )
    expect(fetchPrivateMobileDesignHandoffOgImageMock).toHaveBeenNthCalledWith(
      1,
      'en',
    )
    expect(fetchPrivateMobileDesignHandoffOgImageMock).toHaveBeenNthCalledWith(
      2,
      'ja',
    )
  })
})
