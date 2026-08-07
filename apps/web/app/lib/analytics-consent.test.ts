import { describe, expect, test } from 'vitest'
import {
  CONSENT_REQUIRED_COUNTRIES,
  isAnalyticsConsentState,
  isConsentRequiredRegion,
  resolveAnalyticsConsent,
  type AnalyticsConsentState,
} from './analytics-consent'

describe('isAnalyticsConsentState', () => {
  test('accepts only consent states', () => {
    expect(isAnalyticsConsentState('granted')).toBe(true)
    expect(isAnalyticsConsentState('denied')).toBe(true)
    expect(isAnalyticsConsentState('unset')).toBe(true)
    expect(isAnalyticsConsentState('pending')).toBe(false)
    expect(isAnalyticsConsentState(null)).toBe(false)
    expect(isAnalyticsConsentState(1)).toBe(false)
  })
})

describe('isConsentRequiredRegion', () => {
  test('requires consent for every allowlisted country', () => {
    for (const country of CONSENT_REQUIRED_COUNTRIES) {
      expect(isConsentRequiredRegion(country)).toBe(true)
      expect(isConsentRequiredRegion(country.toLowerCase())).toBe(true)
    }
  })

  test('fails closed for missing and unknown countries', () => {
    expect(isConsentRequiredRegion(undefined)).toBe(true)
    expect(isConsentRequiredRegion(null)).toBe(true)
    expect(isConsentRequiredRegion('')).toBe(true)
    expect(isConsentRequiredRegion('US')).toBe(false)
    expect(isConsentRequiredRegion('JP')).toBe(false)
    expect(isConsentRequiredRegion('BL')).toBe(false)
  })
})

describe('resolveAnalyticsConsent', () => {
  const cases: Array<
    [
      'consent-required' | 'default-on',
      AnalyticsConsentState,
      boolean,
      boolean,
      string,
    ]
  > = [
    ['consent-required', 'unset', false, true, 'DE'],
    ['consent-required', 'granted', true, false, 'DE'],
    ['consent-required', 'denied', false, false, 'DE'],
    ['default-on', 'unset', true, false, 'US'],
    ['default-on', 'granted', true, false, 'US'],
    ['default-on', 'denied', false, false, 'US'],
  ]

  test.each(cases)(
    '%s + %s',
    (region, state, shouldLoad, showBanner, country) => {
      expect(resolveAnalyticsConsent(state, country)).toEqual({
        state,
        region,
        shouldLoadAnalytics: shouldLoad,
        showBanner,
      })
    },
  )
})
