import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'

import { ANALYTICS_EVENTS } from '~/lib/analytics/events'
import {
  setAnalyticsRuntimeState,
  trackEvent,
} from '~/lib/analytics/track.client'
import { clearFirstTouch } from '~/lib/analytics/first-touch.client'
import { clearAllAuthAttempts } from '~/lib/analytics/auth-attempt.client'

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

function loadGtag(measurementId: string, userId: string | null): void {
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
    w0.gtag?.('set', { user_id: userId })
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
  // Apply user_id before config so every page_view carries it.
  w.gtag?.('set', { user_id: userId })
  // cookie_domain 'none' keeps GA cookies host-only so withdrawal cleanup works.
  // send_page_view stays off: page_view is sent explicitly with a sanitized
  // page_location (see AnalyticsGtag), because some routes carry authorization
  // material in the query string (e.g. /device?user_code=...) that must not
  // reach a third-party analytics store.
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
    clearAllAuthAttempts()
    removeAnalyticsCookies(measurementId)
    return
  }

  if (measurementId) {
    // loadGtag applies user_id before config so every hit, including the
    // initial page_view, carries it. null clears a prior user (logout);
    // re-grant also reapplies the current id.
    loadGtag(measurementId, userId)
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

// Query parameters allowed on the page_location sent to GA. Everything else is
// stripped: routes like /device?user_code=... and the signed OAuth sign-in URL
// carry authorization material that must never reach Google.
const PAGE_VIEW_ALLOWED_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_source_platform',
  // Google auto-tagging / cross-domain linker parameters: stripping these
  // would break paid attribution, and they carry no authorization material.
  'gclid',
  'dclid',
  'gbraid',
  'wbraid',
  'srsltid',
  '_gl',
]

function sanitizeUrl(href: string): string {
  const url = new URL(href)
  const kept = new URLSearchParams()
  for (const name of PAGE_VIEW_ALLOWED_PARAMS) {
    const value = url.searchParams.get(name)
    if (value !== null) kept.set(name, value)
  }
  url.search = kept.toString()
  url.hash = ''
  return url.toString()
}

function sanitizedPageLocation(): string {
  return sanitizeUrl(window.location.href)
}

// A same-origin referrer (e.g. /device?user_code=... into a full-page
// sign-in navigation) can carry the same authorization material, so it gets
// the same allowlist. Cross-origin referrers keep their value — that is the
// acquisition signal — and an unparsable one is dropped.
function sanitizedPageReferrer(): string | null {
  const referrer = document.referrer
  if (!referrer) return null
  try {
    const url = new URL(referrer)
    return url.origin === window.location.origin
      ? sanitizeUrl(referrer)
      : referrer
  } catch {
    return null
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
  const location = useLocation()
  const navigationType = useNavigationType()
  // Sanitized location/referrer pinned for the current route (all hits), and
  // the last page_view actually sent (for dedupe across replace cleanups).
  const pinnedPage = useRef<{
    location: string
    referrer: string | null
  } | null>(null)
  const sentPageView = useRef<{ key: string; location: string } | null>(null)
  // All passive event effects run after this layout effect, including a direct
  // landing's ArtifactViewTracker even though it appears earlier in the tree.
  useClientLayoutEffect(() => {
    syncGtagWithConsent(shouldLoadAnalytics, measurementId, userId)
  }, [shouldLoadAnalytics, measurementId, userId])

  // Pin the sanitized page fields globally before any passive event effect
  // runs, so every hit — custom events included — carries the sanitized
  // page_location/page_referrer instead of gtag's raw document.location.
  // For SPA navigations the referrer is the previous in-app page (already
  // sanitized); document.referrer only seeds the initial load.
  useClientLayoutEffect(() => {
    if (!shouldLoadAnalytics || !measurementId) {
      // Forget the pinned page on withdrawal so a later re-grant derives
      // page_referrer from the actual previous page, not a pre-withdrawal one.
      pinnedPage.current = null
      return
    }
    const pageLocation = sanitizedPageLocation()
    const previous = pinnedPage.current
    const referrer =
      previous === null
        ? sanitizedPageReferrer()
        : previous.location === pageLocation
          ? previous.referrer
          : previous.location
    pinnedPage.current = { location: pageLocation, referrer }
    const w = window as unknown as { gtag?: (...args: unknown[]) => void }
    w.gtag?.('set', { page_location: pageLocation, page_referrer: referrer })
  }, [location.key, shouldLoadAnalytics, measurementId])

  // Explicit page_view per route (landing included), so acquisition
  // attribution (UTM, referrer) works. Enhanced Measurement's history-change
  // page_view must stay OFF on the GA4 stream: it would send raw URLs and
  // double-count. A replace navigation whose sanitized location is unchanged
  // (query-parameter cleanup) adopts the new location.key without re-sending;
  // push/pop navigations always count, even when only non-allowlisted query
  // state changed. Consent withdrawal clears the sent marker so a re-grant
  // session gets its landing page_view again.
  useEffect(() => {
    if (!shouldLoadAnalytics || !measurementId) {
      sentPageView.current = null
      return
    }
    const pageLocation = sanitizedPageLocation()
    const previous = sentPageView.current
    if (previous?.key === location.key) return
    if (
      previous !== null &&
      navigationType === 'REPLACE' &&
      previous.location === pageLocation
    ) {
      sentPageView.current = { key: location.key, location: pageLocation }
      return
    }
    // trackEvent reports whether the hit was actually pushed; only then is
    // this location marked as counted, so a missing gtag runtime retries.
    if (
      trackEvent(ANALYTICS_EVENTS.pageView, { page_location: pageLocation })
    ) {
      sentPageView.current = { key: location.key, location: pageLocation }
    }
  }, [location.key, navigationType, shouldLoadAnalytics, measurementId])

  return null
}
