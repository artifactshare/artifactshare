import { useEffect, useLayoutEffect } from 'react'

import { setAnalyticsRuntimeState } from '~/lib/analytics/track.client'
import { clearFirstTouch } from '~/lib/analytics/first-touch.client'

let warnedMissingMeasurementId = false

const useClientLayoutEffect =
  typeof window === 'undefined' ? useEffect : useLayoutEffect

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
  // Queue the complete Google tag snippet before loading gtag.js. Custom
  // events are only eligible to send after this initialization sequence.
  document.head.appendChild(script)
}

// Reconciles the GA4 gtag runtime with the consent state resolved by the root
// loader: loads gtag only when consent allows, otherwise stops and clears GA and
// first-touch cookies. Reads GA4_MEASUREMENT_ID via the measurementId prop.
function syncGtagWithConsent(
  shouldLoadAnalytics: boolean,
  measurementId: string | null,
  userId: string | null,
): void {
  if (!shouldLoadAnalytics) {
    setAnalyticsRuntimeState({ shouldLoadAnalytics: false, measurementId })
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
    loadGtag(measurementId)
    // Apply user_id after config and before enabling the event sender. Since
    // send_page_view is false, the first hit is still the later custom event.
    // null clears a prior user (logout); re-grant also reapplies the current id.
    const w = window as unknown as { gtag?: (...args: unknown[]) => void }
    w.gtag?.('set', { user_id: userId })
    setAnalyticsRuntimeState({ shouldLoadAnalytics: true, measurementId })
    return
  }

  // Consent granted but no Measurement ID configured: nothing to load; warn in
  // dev so a missing GA4_MEASUREMENT_ID is diagnosable.
  setAnalyticsRuntimeState({ shouldLoadAnalytics: true, measurementId: null })
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
  // All passive event effects run after this layout effect, including a direct
  // landing's ArtifactViewTracker even though it appears earlier in the tree.
  useClientLayoutEffect(() => {
    syncGtagWithConsent(shouldLoadAnalytics, measurementId, userId)
  }, [shouldLoadAnalytics, measurementId, userId])

  return null
}
