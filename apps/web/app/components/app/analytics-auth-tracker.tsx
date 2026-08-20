import { useEffect } from 'react'
import { ANALYTICS_EVENTS, ANALYTICS_PARAMS } from '~/lib/analytics/events'
import {
  clearAuthAttempt,
  markAuthCompleted,
  readAuthAttempt,
} from '~/lib/analytics/auth-attempt.client'
import { trackEvent } from '~/lib/analytics/track.client'
import type { AnalyticsSignupPayload } from '~/lib/analytics/signup-payload'

export function AnalyticsAuthTracker({
  authenticated,
  signup,
}: {
  authenticated: boolean
  signup: AnalyticsSignupPayload | null
}): null {
  // OAuth and OTP completion arrive through navigation/session state rather
  // than a component-owned event handler, so an effect is the event boundary.
  useEffect(() => {
    if (!authenticated) return
    let currentArtifactId: string | undefined
    try {
      const match = /^\/a\/([^/]+)$/u.exec(location.pathname)
      currentArtifactId = match?.[1] ? decodeURIComponent(match[1]) : undefined
    } catch {
      currentArtifactId = undefined
    }
    const attempt = readAuthAttempt(currentArtifactId)
    if (!attempt || attempt.authCompletedSent) return
    // react-doctor-disable-next-line react-doctor/no-event-handler
    const accountState = signup ? 'new' : 'existing'
    const sent = trackEvent(ANALYTICS_EVENTS.authCompleted, {
      [ANALYTICS_PARAMS.method]: attempt.method,
      [ANALYTICS_PARAMS.accountState]: accountState,
    })
    if (sent) markAuthCompleted(accountState)
    if (sent && attempt.artifactId) {
      if (currentArtifactId === attempt.artifactId) {
        const returned = trackEvent(
          ANALYTICS_EVENTS.artifactReturnedAfterAuth,
          {
            [ANALYTICS_PARAMS.method]: attempt.method,
            [ANALYTICS_PARAMS.accountState]: accountState,
          },
        )
        if (returned) clearAuthAttempt()
      }
    }
  }, [authenticated, signup])
  return null
}
