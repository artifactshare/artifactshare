import { useEffect } from 'react'
import { useLocation, useRouteLoaderData } from 'react-router'
import {
  ANALYTICS_EVENTS,
  ANALYTICS_PARAMS,
  type AnalyticsRenderType,
} from '~/lib/analytics/events'
import {
  setAnalyticsRuntimeState,
  trackEvent,
} from '~/lib/analytics/track.client'
import { captureFirstTouch } from '~/lib/analytics/first-touch.client'
import {
  referrerDomainFromReferrer,
  utmFromSearch,
} from '~/lib/analytics/first-touch'

const seenArtifactViews = new Set<string>()

function recordArtifactView(input: {
  canTrackView: boolean
  artifactId: string
  renderType: AnalyticsRenderType
  shouldLoad: boolean
  measurementId: string | null
  key: string
  search: string
}): void {
  if (!input.canTrackView) return
  if (seenArtifactViews.has(input.key)) return
  // On a direct landing the AnalyticsGtag sibling effect runs after this one, so
  // initialize the sender's runtime here before sending — otherwise the first
  // artifact_view is dropped (default consent=false) and never retried. The head
  // dataLayer queue then holds the event until gtag.js loads.
  setAnalyticsRuntimeState({
    shouldLoadAnalytics: input.shouldLoad,
    measurementId: input.measurementId,
  })
  captureFirstTouch({
    shouldLoadAnalytics: input.shouldLoad,
    artifactId: input.artifactId,
  })
  const utm = utmFromSearch(input.search)
  const sent = trackEvent(ANALYTICS_EVENTS.artifactView, {
    [ANALYTICS_PARAMS.artifactId]: input.artifactId,
    [ANALYTICS_PARAMS.renderType]: input.renderType,
    [ANALYTICS_PARAMS.referrerDomain]: referrerDomainFromReferrer(
      document.referrer,
    ),
    [ANALYTICS_PARAMS.utmSource]: utm?.utm_source,
    [ANALYTICS_PARAMS.utmMedium]: utm?.utm_medium,
    [ANALYTICS_PARAMS.utmCampaign]: utm?.utm_campaign,
    [ANALYTICS_PARAMS.utmTerm]: utm?.utm_term,
    [ANALYTICS_PARAMS.utmContent]: utm?.utm_content,
  })
  // Mark seen only once actually sent, so a pre-consent view can still fire if
  // consent is granted later (which re-runs the effect via shouldLoad).
  if (sent) seenArtifactViews.add(input.key)
}

export function ArtifactViewTracker({
  artifactId,
  renderType,
  canTrackView,
}: {
  artifactId: string
  renderType: AnalyticsRenderType
  canTrackView: boolean
}): null {
  const location = useLocation()
  const root = useRouteLoaderData<{
    analyticsConsent?: { shouldLoadAnalytics: boolean }
    analyticsMeasurementId?: string | null
  }>('root')
  const shouldLoad = root?.analyticsConsent?.shouldLoadAnalytics ?? false
  const measurementId = root?.analyticsMeasurementId ?? null
  useEffect(() => {
    recordArtifactView({
      canTrackView,
      artifactId,
      renderType,
      shouldLoad,
      measurementId,
      key: `${artifactId}::${location.key}`,
      search: location.search,
    })
  }, [
    artifactId,
    renderType,
    canTrackView,
    location.key,
    location.search,
    shouldLoad,
    measurementId,
  ])
  return null
}
