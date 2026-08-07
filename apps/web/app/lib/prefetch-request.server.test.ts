import { describe, expect, test } from 'vitest'
import { isPrefetchRequest } from './prefetch-request.server'

describe('isPrefetchRequest', () => {
  test('detects browser prefetch purpose headers', () => {
    expect(
      isPrefetchRequest(
        new Request('https://artifactshare.com/a/file.data', {
          headers: { Purpose: 'prefetch' },
        }),
      ),
    ).toBe(true)
    expect(
      isPrefetchRequest(
        new Request('https://artifactshare.com/a/file.data', {
          headers: { 'Sec-Purpose': 'prefetch' },
        }),
      ),
    ).toBe(true)
    expect(
      isPrefetchRequest(
        new Request('https://artifactshare.com/a/file.data', {
          headers: { 'X-Moz': 'prefetch' },
        }),
      ),
    ).toBe(true)
  })

  test('does not treat every data request as prefetch', () => {
    expect(
      isPrefetchRequest(new Request('https://artifactshare.com/a/file.data')),
    ).toBe(false)
    expect(
      isPrefetchRequest(
        new Request('https://artifactshare.com/a/file.data', {
          headers: { 'Sec-Purpose': 'not-prefetch' },
        }),
      ),
    ).toBe(false)
  })

  test('treats prerender like prefetch for side effects', () => {
    expect(
      isPrefetchRequest(
        new Request('https://artifactshare.com/a/file', {
          headers: { 'Sec-Purpose': 'prefetch;prerender' },
        }),
      ),
    ).toBe(true)
  })
})
