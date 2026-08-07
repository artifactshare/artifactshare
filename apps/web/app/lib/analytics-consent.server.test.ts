import { describe, expect, test } from 'vitest'
import {
  analyticsConsentCookieHeader,
  getAnalyticsConsent,
} from './analytics-consent.server'

const requestWithCookie = (cookie?: string) =>
  new Request('https://example.com/', cookie ? { headers: { cookie } } : {})

describe('getAnalyticsConsent', () => {
  test.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['unset', 'unset'],
    ['invalid', 'unset'],
  ] as const)('returns %s for cookie value %s', (value, expected) => {
    const cookie =
      value === 'unset' ? undefined : `__as_analytics_consent=${value}`
    expect(getAnalyticsConsent(requestWithCookie(cookie))).toBe(expected)
  })
})

describe('analyticsConsentCookieHeader', () => {
  test('builds a host-only HttpOnly one-year cookie', () => {
    const header = analyticsConsentCookieHeader('granted')
    expect(header).toContain('__as_analytics_consent=granted')
    expect(header).toContain('Path=/')
    expect(header).toContain('Secure')
    expect(header).toContain('SameSite=Lax')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('Max-Age=31536000')
    expect(header).not.toContain('Domain=')
  })
})
