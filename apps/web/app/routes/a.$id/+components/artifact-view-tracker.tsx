import { useEffect } from 'react'
import { useLocation, useRouteLoaderData } from 'react-router'
import {
  ANALYTICS_EVENTS,
  ANALYTICS_PARAMS,
  type AnalyticsRenderType,
} from '~/lib/analytics/events'
import { trackEvent } from '~/lib/analytics/track.client'
import { captureFirstTouch } from '~/lib/analytics/first-touch.client'
import {
  referrerDomainFromReferrer,
  utmFromSearch,
} from '~/lib/analytics/first-touch'
import type { Visibility } from '~/lib/shareable-types'
import {
  clearAuthAttempt,
  readAuthAttempt,
} from '~/lib/analytics/auth-attempt.client'

const seenArtifactViews = new Set<string>()

function recordArtifactView(input: {
  canTrackView: boolean
  artifactId: string
  renderType: AnalyticsRenderType
  shouldLoad: boolean
  measurementId: string | null
  visibility: Visibility
  viewerState: 'anonymous' | 'authenticated'
  key: string
  search: string
}): void {
  if (!input.canTrackView) return
  if (seenArtifactViews.has(input.key)) return
  captureFirstTouch({
    shouldLoadAnalytics: input.shouldLoad,
    artifactId: input.artifactId,
  })
  const utm = utmFromSearch(input.search)
  const sent = trackEvent(ANALYTICS_EVENTS.artifactView, {
    [ANALYTICS_PARAMS.artifactId]: input.artifactId,
    [ANALYTICS_PARAMS.renderType]: input.renderType,
    [ANALYTICS_PARAMS.visibility]: input.visibility,
    [ANALYTICS_PARAMS.viewerState]: input.viewerState,
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
  if (input.viewerState === 'authenticated') {
    const attempt = readAuthAttempt()
    if (
      attempt?.authCompletedSent &&
      attempt.artifactId === input.artifactId &&
      attempt.accountState
    ) {
      const returned = trackEvent(ANALYTICS_EVENTS.artifactReturnedAfterAuth, {
        [ANALYTICS_PARAMS.method]: attempt.method,
        [ANALYTICS_PARAMS.accountState]: attempt.accountState,
      })
      if (returned) clearAuthAttempt()
    }
  }
}

export function ArtifactViewTracker({
  artifactId,
  renderType,
  canTrackView,
  visibility,
  viewerState,
}: {
  artifactId: string
  renderType: AnalyticsRenderType
  canTrackView: boolean
  visibility: Visibility
  viewerState: 'anonymous' | 'authenticated'
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
      visibility,
      viewerState,
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
    visibility,
    viewerState,
  ])
  return null
}
