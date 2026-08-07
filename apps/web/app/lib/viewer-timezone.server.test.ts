import { describe, expect, test } from 'vitest'
import { getViewerTimezone } from './viewer-timezone.server'

const req = (cookie?: string) =>
  new Request('https://example.com/', {
    headers: cookie === undefined ? undefined : { cookie: `__as_tz=${cookie}` },
  })

describe('getViewerTimezone', () => {
  test.each([
    ['valid IANA', 'America/New_York', 'America/New_York'],
    ['mixed-case IANA', 'aSiA/tOkYo', 'Asia/Tokyo'],
    ['missing', undefined, 'UTC'],
    ['empty', '', 'UTC'],
    ['numeric', '540', 'UTC'],
    ['unsupported', 'Mars/Olympus', 'UTC'],
  ])('%s', (_name, cookie, expected) =>
    expect(getViewerTimezone(req(cookie))).toBe(expected),
  )
})
