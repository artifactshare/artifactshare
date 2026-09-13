// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { setAnalyticsRuntimeState, trackEvent } from './track.client'
const testWindow = window as Window & { gtag?: (...args: unknown[]) => void }

function analyticsTypeChecks(): void {
  trackEvent('copy_link_succeeded')
  trackEvent('copy_link_failed', undefined)
  trackEvent('page_view', { page_location: '/example' })
  trackEvent('first_artifact_posted', {
    channel: 'web',
    engagement_time_msec: 1,
  })
  // @ts-expect-error — required page parameters cannot be omitted.
  trackEvent('page_view')
  // @ts-expect-error — required server event parameters cannot be omitted.
  trackEvent('first_artifact_posted')
  // @ts-expect-error — undefined does not satisfy required parameters.
  trackEvent('page_view', undefined)
  // @ts-expect-error — auth methods use the closed shared vocabulary.
  trackEvent('sign_up_start', { method: 'github' })
  // @ts-expect-error — render types use the closed shared vocabulary.
  trackEvent('artifact_view', { render_type: 'pdf' })
  // @ts-expect-error — artifact IDs are strings.
  trackEvent('artifact_view', { artifact_id: 1 })
  // @ts-expect-error — attribution values are strings.
  trackEvent('sign_up', { utm_source: true })
  // @ts-expect-error — viewer states are closed.
  trackEvent('artifact_view', { viewer_state: 'guest' })
  // @ts-expect-error — account states are closed.
  trackEvent('auth_completed', { account_state: false })
  // @ts-expect-error — visibility is closed.
  trackEvent('artifact_view', { visibility: 'public' })
  // @ts-expect-error — no-param events reject payloads.
  trackEvent('copy_link_failed', { artifact_id: 'a' })
  // @ts-expect-error — event names are closed by the canonical definitions.
  trackEvent('unknown_event')
  // @ts-expect-error — event parameters are closed by the canonical definitions.
  trackEvent('artifact_view', { unknown_dimension: 'value' })
  const invalidParams = { artifact_id: 'a', unknown_dimension: 'value' }
  // @ts-expect-error — variables cannot widen the payload to unknown dimensions.
  trackEvent('artifact_view', invalidParams)
  // @ts-expect-error — parameters cannot be sent to a different event.
  trackEvent('page_view', { artifact_id: 'a' })
}

describe('trackEvent', () => {
  beforeEach(() => {
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: false,
      measurementId: null,
    })
    delete testWindow.gtag
  })
  test('does not send without consent', () => {
    const gtag = vi.fn()
    testWindow.gtag = gtag
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: false,
      measurementId: 'G-x',
    })
    expect(trackEvent('artifact_view')).toBe(false)
    expect(gtag).not.toHaveBeenCalled()
  })
  test('does not send without measurement id', () => {
    const gtag = vi.fn()
    testWindow.gtag = gtag
    setAnalyticsRuntimeState({ shouldLoadAnalytics: true, measurementId: null })
    expect(trackEvent('artifact_view')).toBe(false)
    expect(gtag).not.toHaveBeenCalled()
  })
  test('sends and returns true, removing undefined parameters', () => {
    const gtag = vi.fn()
    testWindow.gtag = gtag
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: true,
      measurementId: 'G-x',
    })
    expect(
      trackEvent('artifact_view', {
        artifact_id: 'a',
        referrer_domain: undefined,
      }),
    ).toBe(true)
    expect(gtag).toHaveBeenCalledWith('event', 'artifact_view', {
      artifact_id: 'a',
    })
  })
  test('does not throw or send when gtag is absent', () => {
    setAnalyticsRuntimeState({
      shouldLoadAnalytics: true,
      measurementId: 'G-x',
    })
    expect(trackEvent('artifact_view')).toBe(false)
    expect(() => trackEvent('artifact_view')).not.toThrow()
  })
})
