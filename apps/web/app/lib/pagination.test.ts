import { describe, expect, test } from 'vitest'
import { parsePageParam } from './pagination'

describe('parsePageParam', () => {
  test.each([undefined, 'nope', '0', '-2'])('invalid %s returns 1', (page) => {
    const params = new URLSearchParams()
    if (page !== undefined) params.set('page', page)
    expect(parsePageParam(params)).toBe(1)
  })

  test.each(['1', '2', '99'])('positive integer %s is preserved', (page) => {
    expect(parsePageParam(new URLSearchParams({ page }))).toBe(Number(page))
  })
})
