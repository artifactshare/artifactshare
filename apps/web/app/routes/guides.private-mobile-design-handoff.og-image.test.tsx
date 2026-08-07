import { describe, expect, test, vi } from 'vitest'

const fetchPrivateMobileDesignHandoffOgImageMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/og-image-worker.server', () => ({
  fetchPrivateMobileDesignHandoffOgImage:
    fetchPrivateMobileDesignHandoffOgImageMock,
}))

import { loader as enLoader } from './guides.private-mobile-design-handoff.og-image'
import { loader as jaLoader } from './ja.guides.private-mobile-design-handoff.og-image'

describe('private mobile design handoff OGP routes', () => {
  test('delegates each locale to the matching worker request', async () => {
    const enResponse = new Response('en')
    const jaResponse = new Response('ja')
    fetchPrivateMobileDesignHandoffOgImageMock
      .mockResolvedValueOnce(enResponse)
      .mockResolvedValueOnce(jaResponse)

    await expect(enLoader()).resolves.toBe(enResponse)
    await expect(jaLoader()).resolves.toBe(jaResponse)
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
