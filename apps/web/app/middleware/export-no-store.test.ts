import { expect, test, vi } from 'vitest'
import { exportNoStoreMiddleware } from './export-no-store'

test('export responses and auth-guard failures are not cached', async () => {
  const response = new Response('asset', {
    headers: { 'cache-control': 'private,max-age=300' },
  })
  expect(
    await exportNoStoreMiddleware(
      {} as never,
      vi.fn().mockResolvedValue(response),
    ),
  ).toBe(response)
  expect(response.headers.get('cache-control')).toBe('no-store')
  const unauthorized = new Response('Unauthorized', { status: 401 })
  await expect(
    exportNoStoreMiddleware(
      {} as never,
      vi.fn().mockRejectedValue(unauthorized),
    ),
  ).rejects.toBe(unauthorized)
  expect(unauthorized.headers.get('cache-control')).toBe('no-store')
})
