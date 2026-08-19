// @vitest-environment happy-dom
import React, { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { trackEvent } from '~/lib/analytics/track.client'

import { AnalyticsGtag } from './analytics-gtag'

describe('AnalyticsGtag', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    document.head.innerHTML = ''
    document.cookie = '_ga=; Path=/; Max-Age=0'
    document.cookie = '_ga_TEST=; Path=/; Max-Age=0'
    ;(window as unknown as { gtag: ReturnType<typeof vi.fn> }).gtag = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    root.unmount()
    container.remove()
    document.head.innerHTML = ''
    document.cookie = '_ga=; Path=/; Max-Age=0'
    document.cookie = '_ga_TEST=; Path=/; Max-Age=0'
  })

  it('does not load when consent is false', async () => {
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics={false}
          measurementId="G-TEST"
          userId={null}
        />,
      )
    })
    expect(document.getElementById('as-gtag-js')).toBeNull()
  })

  it('loads and initializes gtag once', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics
          measurementId="G-TEST"
          userId="u-hash"
        />,
      )
    })
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics
          measurementId="G-TEST"
          userId="u-hash"
        />,
      )
    })
    expect(document.querySelectorAll('#as-gtag-js')).toHaveLength(1)
    expect(
      document.querySelector('#as-gtag-js')?.getAttribute('src'),
    ).toContain('id=G-TEST')
    expect(gtag).toHaveBeenCalledWith('config', 'G-TEST', {
      send_page_view: false,
      cookie_domain: 'none',
    })
    expect(gtag).toHaveBeenCalledWith('set', { user_id: 'u-hash' })
  })

  it('queues consent, js, config, and user_id in order', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics
          measurementId="G-TEST"
          userId="u-hash"
        />,
      )
    })
    expect(gtag.mock.calls.map(([command]) => command)).toEqual([
      'consent',
      'js',
      'config',
      'set',
    ])
  })

  it('initializes before a preceding sibling passive event', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    function DirectLandingEvent() {
      useEffect(() => {
        trackEvent('artifact_view', { artifact_id: 'direct' })
      }, [])
      return null
    }
    await React.act(async () => {
      root.render(
        <>
          <DirectLandingEvent />
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId={null}
          />
        </>,
      )
    })
    expect(gtag.mock.calls.map(([command]) => command)).toEqual([
      'consent',
      'js',
      'config',
      'set',
      'event',
    ])
    expect(gtag).toHaveBeenLastCalledWith('event', 'artifact_view', {
      artifact_id: 'direct',
    })
  })

  it('sends a pending passive event once consent becomes available', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    function ConsentAwareEvent({ shouldLoad }: { shouldLoad: boolean }) {
      useEffect(() => {
        trackEvent('artifact_view', { artifact_id: 'after-consent' })
      }, [shouldLoad])
      return null
    }
    const render = (shouldLoad: boolean) => (
      <>
        <ConsentAwareEvent shouldLoad={shouldLoad} />
        <AnalyticsGtag
          shouldLoadAnalytics={shouldLoad}
          measurementId="G-TEST"
          userId={null}
        />
      </>
    )
    await React.act(async () => root.render(render(false)))
    expect(gtag).not.toHaveBeenCalledWith(
      'event',
      'artifact_view',
      expect.anything(),
    )

    await React.act(async () => root.render(render(true)))
    expect(gtag.mock.calls.map(([command]) => command)).toEqual([
      'consent',
      'js',
      'config',
      'set',
      'event',
    ])
    expect(gtag).toHaveBeenLastCalledWith('event', 'artifact_view', {
      artifact_id: 'after-consent',
    })
  })

  it('denies consent in the loaded runtime and cleans cookies on withdrawal', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    document.cookie = '_ga=x; Path=/'
    document.cookie = '_ga_TEST=y; Path=/'
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics
          measurementId="G-TEST"
          userId="u-hash"
        />,
      )
    })
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics={false}
          measurementId="G-TEST"
          userId={null}
        />,
      )
    })
    // gtag.js was loaded, so withdrawal must tell GA consent is denied — not
    // just clear cookies — or Enhanced Measurement keeps collecting.
    expect(gtag).toHaveBeenCalledWith('consent', 'update', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    })
    expect(document.cookie).not.toContain('_ga=x')
    expect(document.cookie).not.toContain('_ga_TEST=y')
    expect(gtag).not.toHaveBeenCalledWith('set', { user_id: null })
  })

  it('clears the user id when consent is granted without a user', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics
          measurementId="G-TEST"
          userId={null}
        />,
      )
    })
    expect(gtag).toHaveBeenCalledWith('set', { user_id: null })
  })

  it('restores granted consent when re-granted after withdrawal', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics
          measurementId="G-TEST"
          userId="u-hash"
        />,
      )
    })
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics={false}
          measurementId="G-TEST"
          userId={null}
        />,
      )
    })
    gtag.mockClear()
    await React.act(async () => {
      root.render(
        <AnalyticsGtag
          shouldLoadAnalytics
          measurementId="G-TEST"
          userId="u-hash"
        />,
      )
    })
    // gtag.js is already loaded, so a re-grant must restore granted (not
    // re-inject and not stay denied).
    expect(gtag).toHaveBeenCalledWith('consent', 'update', {
      analytics_storage: 'granted',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    })
    expect(document.querySelectorAll('#as-gtag-js')).toHaveLength(1)
  })
})
