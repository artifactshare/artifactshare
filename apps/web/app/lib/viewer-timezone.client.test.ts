import { describe, expect, test, vi } from 'vitest'
import {
  getBrowserTimeZone,
  timezoneSyncAction,
} from './viewer-timezone.client'

describe('getBrowserTimeZone', () => {
  test('returns the browser IANA timezone', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      locale: 'en',
      calendar: 'gregory',
      numberingSystem: 'latn',
      timeZone: 'Asia/Tokyo',
    })

    expect(getBrowserTimeZone()).toBe('Asia/Tokyo')
    vi.restoreAllMocks()
  })

  test('falls back to UTC when timezone detection fails', () => {
    vi.spyOn(
      Intl.DateTimeFormat.prototype,
      'resolvedOptions',
    ).mockImplementation(() => {
      throw new Error('unavailable')
    })

    expect(getBrowserTimeZone()).toBe('UTC')
    vi.restoreAllMocks()
  })
})

describe('timezoneSyncAction', () => {
  test('does nothing when the cookie already matches', () => {
    expect(timezoneSyncAction('Asia/Tokyo', 'Asia/Tokyo')).toEqual({
      writeCookie: false,
      revalidate: false,
    })
  })

  test('writes and revalidates when the timezone changes', () => {
    expect(timezoneSyncAction('UTC', 'America/New_York')).toEqual({
      writeCookie: true,
      revalidate: true,
    })
  })

  test('writes without revalidation for a missing UTC cookie', () => {
    expect(timezoneSyncAction(null, 'UTC')).toEqual({
      writeCookie: true,
      revalidate: false,
    })
  })

  test('writes and revalidates for a missing non-UTC cookie', () => {
    expect(timezoneSyncAction(null, 'Asia/Tokyo')).toEqual({
      writeCookie: true,
      revalidate: true,
    })
  })
})
