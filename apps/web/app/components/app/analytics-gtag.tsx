import { useEffect } from 'react'

import { setAnalyticsRuntimeState } from '~/lib/analytics/track.client'
import { clearFirstTouch } from '~/lib/analytics/first-touch.client'

let warnedMissingMeasurementId = false

function removeAnalyticsCookies(measurementId: string | null): void {
  const cookieNames = ['_ga']
  if (measurementId) {
    cookieNames.push(`_ga_${measurementId.replace(/^G-/, '')}`)
  }
  for (const name of cookieNames) {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Lax`
  }
}

function loadGtag(measurementId: string): void {
  const w0 = window as unknown as { gtag?: (...args: unknown[]) => void }
  if (document.getElementById('as-gtag-js')) {
    // Already loaded (e.g. consent re-granted after a withdrawal that set
    // analytics_storage denied): restore granted rather than re-injecting.
    w0.gtag?.('consent', 'update', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    })
    return
  }
  const script = document.createElement('script')
  script.id = 'as-gtag-js'
  script.async = true
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId
  document.head.appendChild(script)

  const w = window as unknown as { gtag?: (...args: unknown[]) => void }
  // Basic consent mode: gtag only loads once consent allows, so analytics is
  // granted while ad signals stay denied.
  w.gtag?.('consent', 'default', {
    analytics_storage: 'granted',
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
  })
  w.gtag?.('js', new Date())
  // cookie_domain 'none' keeps GA cookies host-only so withdrawal cleanup works.
  w.gtag?.('config', measurementId, {
    send_page_view: false,
    cookie_domain: 'none',
  })
}

// Reconciles the GA4 gtag runtime with the consent state resolved by the root
// loader: loads gtag only when consent allows, otherwise stops and clears GA and
// first-touch cookies. Reads GA4_MEASUREMENT_ID via the measurementId prop.
function syncGtagWithConsent(
  shouldLoadAnalytics: boolean,
  measurementId: string | null,
  userId: string | null,
): void {
  setAnalyticsRuntimeState({ shouldLoadAnalytics, measurementId })

  if (!shouldLoadAnalytics) {
    // Consent not granted (withdrawn or pre-consent in the EU). If gtag.js is
    // already loaded, tell it consent is denied so GA stops using analytics
    // storage (Enhanced Measurement etc.) — not just our own wrapper — then
    // drop the first-touch attribution and GA cookies so nothing is retained.
    if (document.getElementById('as-gtag-js')) {
      const w = window as unknown as { gtag?: (...args: unknown[]) => void }
      w.gtag?.('consent', 'update', {
        analytics_storage: 'denied',
        ad_storage: 'denied',
        ad_user_data: 'denied',
        ad_personalization: 'denied',
      })
    }
    clearFirstTouch()
    removeAnalyticsCookies(measurementId)
    return
  }

  if (measurementId) {
    // Establish user_id before gtag's config/first hit so login-time funnel
    // events carry it, independent of send_page_view. null clears a prior user
    // (logout). On re-grant after withdrawal loadGtag only flips consent back,
    // so this set is also what re-applies user_id then.
    const w = window as unknown as { gtag?: (...args: unknown[]) => void }
    w.gtag?.('set', { user_id: userId })
    loadGtag(measurementId)
    return
  }

  // Consent granted but no Measurement ID configured: nothing to load; warn in
  // dev so a missing GA4_MEASUREMENT_ID is diagnosable.
  removeAnalyticsCookies(measurementId)
  if (import.meta.env.DEV && !warnedMissingMeasurementId) {
    warnedMissingMeasurementId = true
    console.warn('[analytics] GA4_MEASUREMENT_ID is not set; gtag not loaded')
  }
}

export function AnalyticsGtag({
  shouldLoadAnalytics,
  measurementId,
  userId,
}: {
  shouldLoadAnalytics: boolean
  measurementId: string | null
  userId: string | null
}): null {
  useEffect(() => {
    syncGtagWithConsent(shouldLoadAnalytics, measurementId, userId)
  }, [shouldLoadAnalytics, measurementId, userId])

  return null
}
