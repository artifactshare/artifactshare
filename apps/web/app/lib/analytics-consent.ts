export type AnalyticsConsentState = 'granted' | 'denied' | 'unset'

export function isAnalyticsConsentState(
  value: unknown,
): value is AnalyticsConsentState {
  return value === 'granted' || value === 'denied' || value === 'unset'
}

export const CONSENT_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set([
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
  'AX',
  'GF',
  'GP',
  'MQ',
  'RE',
  'YT',
  'MF',
  'IS',
  'LI',
  'NO',
  'GB',
])

export function isConsentRequiredRegion(
  country: string | undefined | null,
): boolean {
  return !country || CONSENT_REQUIRED_COUNTRIES.has(country.toUpperCase())
}

export interface AnalyticsConsentResolution {
  state: AnalyticsConsentState
  region: 'consent-required' | 'default-on'
  shouldLoadAnalytics: boolean
  showBanner: boolean
}

export function resolveAnalyticsConsent(
  state: AnalyticsConsentState,
  country: string | undefined | null,
): AnalyticsConsentResolution {
  const region = isConsentRequiredRegion(country)
    ? 'consent-required'
    : 'default-on'

  return {
    state,
    region,
    shouldLoadAnalytics:
      state === 'granted' || (region === 'default-on' && state === 'unset'),
    showBanner: region === 'consent-required' && state === 'unset',
  }
}
