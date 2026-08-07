import { readCookie, serializeCookie } from './cookies.server'
import type { AnalyticsConsentState } from './analytics-consent'

const ANALYTICS_CONSENT_COOKIE = '__as_analytics_consent'

export function getAnalyticsConsent(request: Request): AnalyticsConsentState {
  const value = readCookie(request, ANALYTICS_CONSENT_COOKIE)
  return value === 'granted' || value === 'denied' ? value : 'unset'
}

export function analyticsConsentCookieHeader(
  value: 'granted' | 'denied',
): string {
  return serializeCookie(ANALYTICS_CONSENT_COOKIE, value, {
    maxAgeSeconds: 31536000,
    httpOnly: true,
  })
}
