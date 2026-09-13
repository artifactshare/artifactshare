// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { setAnalyticsRuntimeState, trackEvent } from './track.client'
const testWindow = window as Window & { gtag?: (...args: unknown[]) => void }

function analyticsTypeChecks(): void {
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
