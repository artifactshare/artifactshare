import { describe, expect, it } from 'vitest'
import {
  firstTouchClearCookieHeader,
  readFirstTouch,
} from './first-touch.server'

describe('first-touch server', () => {
  it('reads an encoded first-touch cookie', () => {
    const value = { utm: { utm_source: 'a' }, artifactId: 'id1' }
    const request = new Request('https://example.com', {
      headers: {
        Cookie: `__as_first_touch=${encodeURIComponent(JSON.stringify(value))}`,
      },
    })
    expect(readFirstTouch(request)).toEqual(value)
    expect(readFirstTouch(new Request('https://example.com'))).toBeNull()
    expect(
      readFirstTouch(
        new Request('https://example.com', {
          headers: { Cookie: '__as_first_touch=%7B' },
        }),
      ),
    ).toBeNull()
  })

  it('returns a clearing cookie header', () => {
    const header = firstTouchClearCookieHeader()
    expect(header).toContain('__as_first_touch=')
    expect(header).toContain('Max-Age=0')
  })
})
