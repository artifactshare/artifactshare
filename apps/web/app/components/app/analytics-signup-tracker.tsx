import { useEffect, useRef } from 'react'
import { useFetcher } from 'react-router'
import { ANALYTICS_EVENTS, ANALYTICS_PARAMS } from '~/lib/analytics/events'
import { trackEvent } from '~/lib/analytics/track.client'
import type { AnalyticsSignupPayload } from '~/lib/analytics/signup-payload'

function fireSignupEvents(signup: AnalyticsSignupPayload): void {
  const firstTouch = signup.firstTouch
  const params = {
    [ANALYTICS_PARAMS.method]: signup.method,
    [ANALYTICS_PARAMS.artifactId]: firstTouch?.artifactId,
    [ANALYTICS_PARAMS.referrerDomain]: firstTouch?.referrerDomain,
    [ANALYTICS_PARAMS.utmSource]: firstTouch?.utm?.utm_source,
    [ANALYTICS_PARAMS.utmMedium]: firstTouch?.utm?.utm_medium,
    [ANALYTICS_PARAMS.utmCampaign]: firstTouch?.utm?.utm_campaign,
    [ANALYTICS_PARAMS.utmTerm]: firstTouch?.utm?.utm_term,
    [ANALYTICS_PARAMS.utmContent]: firstTouch?.utm?.utm_content,
  }
  trackEvent(ANALYTICS_EVENTS.signUp, params)
  if (signup.workspaceCreated) {
    trackEvent(ANALYTICS_EVENTS.workspaceCreated, params)
  }
}

export function AnalyticsSignupTracker({
  signup,
}: {
  signup: AnalyticsSignupPayload | null
}): null {
  const firedRef = useRef(false)
  // Destructure the stable submit method; the fetcher object itself must not be
  // an effect dependency (it changes each render).
  const { submit } = useFetcher()

  useEffect(() => {
    if (!signup) {
      firedRef.current = false
      return
    }
    if (firedRef.current) return
    firedRef.current = true
    fireSignupEvents(signup)
    submit(null, { method: 'POST', action: '/set-analytics-tracked' })
  }, [signup, submit])

  return null
}
