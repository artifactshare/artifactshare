import { describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({
  env: {},
}))

const { HANG, raceHang } = await import('./auth.server')

describe('raceHang', () => {
  test('returns the promise value when it settles within the window', async () => {
    await expect(raceHang(Promise.resolve('ok'), 1000)).resolves.toBe('ok')
  })

  test('propagates a rejection that happens within the window', async () => {
    await expect(
      raceHang(Promise.reject(new Error('boom')), 1000),
    ).rejects.toThrow('boom')
  })

  test('resolves HANG when the promise stays pending past the window', async () => {
    vi.useFakeTimers()
    try {
      const pending = new Promise(() => {})
      const race = raceHang(pending, 3000)
      await vi.advanceTimersByTimeAsync(3001)
      await expect(race).resolves.toBe(HANG)
    } finally {
      vi.useRealTimers()
    }
  })

  test('swallows a late rejection from the abandoned loser', async () => {
    vi.useFakeTimers()
    try {
      let rejectLoser: (error: Error) => void = () => {}
      const loser = new Promise((_, reject) => {
        rejectLoser = reject
      })
      const race = raceHang(loser, 1000)
      await vi.advanceTimersByTimeAsync(1001)
      await expect(race).resolves.toBe(HANG)
      rejectLoser(new Error('late failure'))
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
