import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'

import { ANALYTICS_EVENTS } from '~/lib/analytics/events'
import {
  setAnalyticsRuntimeState,
  trackEvent,
} from '~/lib/analytics/track.client'
import { clearFirstTouch } from '~/lib/analytics/first-touch.client'
import { clearAllAuthAttempts } from '~/lib/analytics/auth-attempt.client'

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
  w.gtag?.('config', measurementId, {
    send_page_view: false,
    cookie_domain: 'none',
  })
  // Queue the complete Google tag snippet before loading gtag.js. Custom
  // events are only eligible to send after this initialization sequence.
  document.head.appendChild(script)
}

function syncGtagWithConsent(
  shouldLoadAnalytics: boolean,
  measurementId: string | null,
  userId: string | null,
): void {
  if (!shouldLoadAnalytics) {
    setAnalyticsRuntimeState({ shouldLoadAnalytics: false, measurementId })
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
    loadGtag(measurementId, userId)
    setAnalyticsRuntimeState({ shouldLoadAnalytics: true, measurementId })
    return
  }

  setAnalyticsRuntimeState({ shouldLoadAnalytics: true, measurementId: null })
  removeAnalyticsCookies(measurementId)
}

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

function sanitizedPageTitle(pathname: string): string {
  const fixed: Record<string, string> = {
    '/files': 'Files',
    '/recent': 'Recent',
    '/activity': 'Activity',
    '/projects': 'Projects',
    '/projects/archived': 'Archived projects',
    '/access-requests': 'Access requests',
    '/sign-in': 'Sign in',
    '/device': 'Device authorization',
    '/consent': 'Consent',
    '/connect/slack': 'Integration',
    '/integrations/slack/install': 'Integration',
  }
  let label = fixed[pathname]
  if (/^\/a\/[^/]+$/.test(pathname)) label = 'Artifact'
  else if (/^\/projects\/[^/]+\/slack\/install$/.test(pathname))
    label = 'Integration'
  else if (/^\/projects\/[^/]+\/files$/.test(pathname)) label = 'Project files'
  else if (/^\/projects\/[^/]+\/activity$/.test(pathname))
    label = 'Project activity'
  else if (/^\/projects\/[^/]+\/slack$/.test(pathname))
    label = 'Project integration'
  else if (!label && /^\/projects\/[^/]+$/.test(pathname)) label = 'Project'
  else if (/^\/settings(?:\/.*)?$/.test(pathname)) label = 'Settings'
  else if (/^\/ops\/link\/[^/]+$/.test(pathname)) label = 'Link review'

  const publicPath = pathname.replace(/^\/(?:en|ja)(?=\/|$)/, '') || '/'
  const publicLabels: Record<string, string> = {
    '/': 'Home',
    '/pricing': 'Pricing',
    '/about': 'About',
    '/start': 'Start',
    '/share-with-ai': 'Share with AI',
    '/connect': 'Integration',
    '/terms': 'Terms',
    '/privacy': 'Privacy',
    '/tokushoho': 'Legal',
    '/updates': 'Updates',
    '/guides/cli': 'Guide',
    '/guides/link-sharing': 'Guide',
    '/guides/search': 'Guide',
    '/guides/workspace-admin': 'Guide',
    '/guides/workspace-owner': 'Guide',
    '/guides/private-mobile-design-handoff': 'Guide',
  }
  label ??= publicLabels[publicPath]
  if (/^\/updates\/[^/]+$/.test(publicPath)) label = 'Updates'
  return label ? `${label} · Artifact Share` : 'Artifact Share'
}

function sanitizedPageLocation(): string {
  return sanitizeUrl(window.location.href)
}

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
  const pinnedPage = useRef<{
    location: string
    referrer: string | null
    title: string
  } | null>(null)
  const sentPageView = useRef<{ key: string; location: string } | null>(null)
  // Pin the sanitized page fields globally before any passive event effect
  // runs, so every hit — custom events included — carries the sanitized
  // page_location/page_referrer instead of gtag's raw document.location.
  useClientLayoutEffect(() => {
    if (!shouldLoadAnalytics || !measurementId) {
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
    const title = sanitizedPageTitle(location.pathname)
    pinnedPage.current = { location: pageLocation, referrer, title }
    const w = window as unknown as { gtag?: (...args: unknown[]) => void }
    w.gtag?.('set', {
      page_location: pageLocation,
      page_referrer: referrer,
      page_title: title,
    })
  }, [location.key, location.pathname, shouldLoadAnalytics, measurementId])

  // All passive event effects run after this layout effect, including a direct
  // landing's ArtifactViewTracker even though it appears earlier in the tree.
  useClientLayoutEffect(() => {
    syncGtagWithConsent(shouldLoadAnalytics, measurementId, userId)
  }, [shouldLoadAnalytics, measurementId, userId])

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
    if (
      trackEvent(ANALYTICS_EVENTS.pageView, {
        page_location: pageLocation,
        page_title: pinnedPage.current!.title,
      })
    ) {
      sentPageView.current = { key: location.key, location: pageLocation }
    }
  }, [location.key, navigationType, shouldLoadAnalytics, measurementId])

  return null
}
