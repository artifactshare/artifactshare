// @vitest-environment happy-dom
import React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  captureAuthAttempt,
  clearAuthAttempt,
  readAuthAttempt,
} from '~/lib/analytics/auth-attempt.client'
import { setAnalyticsRuntimeState } from '~/lib/analytics/track.client'
import { AnalyticsAuthTracker } from './analytics-auth-tracker'

describe('AnalyticsAuthTracker', () => {
  const container = document.createElement('div')
  const root = createRoot(container)
  const gtag = vi.fn()

  beforeEach(() => {
    gtag.mockClear()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: true,
      measurementId: 'G-TEST',
    })
    clearAuthAttempt()
    history.replaceState(null, '', '/a/example')
  })

  afterEach(() => {
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: false,
      measurementId: null,
    })
  })

  test('sends existing sign-in completion and same-artifact return once', async () => {
    captureAuthAttempt({
      method: 'google',
      callbackURL: '/a/example',
      shouldLoadAnalytics: true,
    })
    await React.act(async () => {
      root.render(
        <AnalyticsAuthTracker
          authenticated
          signup={null}
          shouldLoadAnalytics
        />,
      )
    })
    expect(gtag).toHaveBeenCalledWith('event', 'auth_completed', {
      method: 'google',
      account_state: 'existing',
    })
    expect(gtag).toHaveBeenCalledWith('event', 'artifact_returned_after_auth', {
      method: 'google',
      account_state: 'existing',
    })
    expect(readAuthAttempt()).toBeNull()

    await React.act(async () => {
      root.render(
        <AnalyticsAuthTracker
          authenticated
          signup={null}
          shouldLoadAnalytics
        />,
      )
    })
    expect(gtag).toHaveBeenCalledTimes(2)
  })

  test('retries completion when analytics consent is granted later', async () => {
    captureAuthAttempt({
      method: 'email',
      callbackURL: '/a/example',
      shouldLoadAnalytics: true,
    })
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: false,
      measurementId: 'G-TEST',
    })
    await React.act(async () => {
      root.render(
        <AnalyticsAuthTracker
          authenticated
          signup={null}
          shouldLoadAnalytics={false}
        />,
      )
    })
    expect(gtag).not.toHaveBeenCalled()

    setAnalyticsRuntimeState({
      shouldLoadAnalytics: true,
      measurementId: 'G-TEST',
    })
    await React.act(async () => {
      root.render(
        <AnalyticsAuthTracker
          authenticated
          signup={null}
          shouldLoadAnalytics
        />,
      )
    })
    expect(gtag).toHaveBeenCalledWith('event', 'auth_completed', {
      method: 'email',
      account_state: 'existing',
    })
  })
})
