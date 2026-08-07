// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { setAnalyticsRuntimeState, trackEvent } from './track.client'
const testWindow = window as Window & { gtag?: (...args: unknown[]) => void }
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
