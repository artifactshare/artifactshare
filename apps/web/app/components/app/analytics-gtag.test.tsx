// @vitest-environment happy-dom
import React, { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useNavigate } from 'react-router'
import { trackEvent } from '~/lib/analytics/track.client'

import { AnalyticsGtag } from './analytics-gtag'

describe('AnalyticsGtag', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    window.history.replaceState({}, '', '/')
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
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics={false}
            measurementId="G-TEST"
            userId={null}
          />
        </MemoryRouter>,
      )
    })
    expect(document.getElementById('as-gtag-js')).toBeNull()
  })

  it('loads and initializes gtag once', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    await React.act(async () => {
      root.render(
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId="u-hash"
          />
        </MemoryRouter>,
      )
    })
    await React.act(async () => {
      root.render(
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId="u-hash"
          />
        </MemoryRouter>,
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
    expect(
      gtag.mock.calls.filter(([command]) => command === 'config'),
    ).toHaveLength(1)
    expect(gtag).toHaveBeenCalledWith('set', { user_id: 'u-hash' })
    // page_view is explicit (send_page_view is false) and sent once per route.
    expect(
      gtag.mock.calls.filter(
        ([command, name]) => command === 'event' && name === 'page_view',
      ),
    ).toHaveLength(1)
  })

  it('queues consent, js, user_id, config, page fields, and page_view in order', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    await React.act(async () => {
      root.render(
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId="u-hash"
          />
        </MemoryRouter>,
      )
    })
    expect(gtag.mock.calls.map(([command]) => command)).toEqual([
      'consent',
      'js',
      'set',
      'config',
      'set',
      'event',
    ])
    expect(gtag).toHaveBeenLastCalledWith('event', 'page_view', {
      page_location: expect.stringContaining('http'),
    })
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
        <MemoryRouter>
          <DirectLandingEvent />
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId={null}
          />
        </MemoryRouter>,
      )
    })
    expect(gtag.mock.calls.map(([command]) => command)).toEqual([
      'consent',
      'js',
      'set',
      'config',
      'set',
      'event',
      'event',
    ])
    expect(gtag).toHaveBeenCalledWith('event', 'artifact_view', {
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
      <MemoryRouter>
        <ConsentAwareEvent shouldLoad={shouldLoad} />
        <AnalyticsGtag
          shouldLoadAnalytics={shouldLoad}
          measurementId="G-TEST"
          userId={null}
        />
      </MemoryRouter>
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
      'set',
      'config',
      'set',
      'event',
      'event',
    ])
    expect(gtag).toHaveBeenCalledWith('event', 'artifact_view', {
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
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId="u-hash"
          />
        </MemoryRouter>,
      )
    })
    await React.act(async () => {
      root.render(
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics={false}
            measurementId="G-TEST"
            userId={null}
          />
        </MemoryRouter>,
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
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId={null}
          />
        </MemoryRouter>,
      )
    })
    expect(gtag).toHaveBeenCalledWith('set', { user_id: null })
  })

  it('restores granted consent when re-granted after withdrawal', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    await React.act(async () => {
      root.render(
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId="u-hash"
          />
        </MemoryRouter>,
      )
    })
    await React.act(async () => {
      root.render(
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics={false}
            measurementId="G-TEST"
            userId={null}
          />
        </MemoryRouter>,
      )
    })
    gtag.mockClear()
    await React.act(async () => {
      root.render(
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId="u-hash"
          />
        </MemoryRouter>,
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

  it('strips non-allowlisted query parameters from page_view', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    window.history.replaceState(
      {},
      '',
      '/device?user_code=SECRET&utm_source=x&utm_campaign=exp001#frag',
    )
    await React.act(async () => {
      root.render(
        <MemoryRouter>
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId={null}
          />
        </MemoryRouter>,
      )
    })
    const pageView = gtag.mock.calls.find(
      ([command, name]) => command === 'event' && name === 'page_view',
    )
    if (!pageView) throw new Error('page_view not sent')
    const { page_location } = pageView[2] as { page_location: string }
    expect(page_location).toContain('utm_source=x')
    expect(page_location).toContain('utm_campaign=exp001')
    expect(page_location).not.toContain('user_code')
    expect(page_location).not.toContain('SECRET')
    expect(page_location).not.toContain('#')
    window.history.replaceState({}, '', '/')
  })

  it('sends one page_view per route and dedupes replace-only query changes', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    function Navigator({
      to,
      replace = false,
    }: {
      to: string | null
      replace?: boolean
    }) {
      const navigate = useNavigate()
      const doneRef = React.useRef<string | null>(null)
      useEffect(() => {
        if (to && doneRef.current !== to) {
          doneRef.current = to
          if (replace) window.history.replaceState({}, '', to)
          else window.history.pushState({}, '', to)
          navigate(to, { replace })
        }
      }, [to, replace, navigate])
      return null
    }
    const render = (to: string | null, replace = false) => (
      <MemoryRouter>
        <Navigator to={to} replace={replace} />
        <AnalyticsGtag
          shouldLoadAnalytics
          measurementId="G-TEST"
          userId={null}
        />
      </MemoryRouter>
    )
    const pageViews = () =>
      gtag.mock.calls.filter(
        ([command, name]) => command === 'event' && name === 'page_view',
      )
    await React.act(async () => root.render(render(null)))
    expect(pageViews()).toHaveLength(1)

    await React.act(async () =>
      root.render(render('/pricing?utm_source=x&session_token=SECRET')),
    )
    expect(pageViews()).toHaveLength(2)
    const { page_location } = pageViews()[1][2] as { page_location: string }
    expect(page_location).toContain('/pricing?utm_source=x')
    expect(page_location).not.toContain('SECRET')

    // A replace navigation that only strips a non-allowlisted query parameter
    // changes location.key but not the sanitized page — no extra page_view.
    await React.act(async () =>
      root.render(render('/pricing?utm_source=x', true)),
    )
    expect(pageViews()).toHaveLength(2)

    // A push navigation still counts even when only non-allowlisted query
    // state changes (e.g. pagination): the user did move to a new view.
    await React.act(async () =>
      root.render(render('/pricing?utm_source=x&page=2')),
    )
    expect(pageViews()).toHaveLength(3)
  })

  it('sends the landing page_view again after withdrawal and re-grant', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    const render = (shouldLoad: boolean) => (
      <MemoryRouter>
        <AnalyticsGtag
          shouldLoadAnalytics={shouldLoad}
          measurementId="G-TEST"
          userId={null}
        />
      </MemoryRouter>
    )
    const pageViews = () =>
      gtag.mock.calls.filter(
        ([command, name]) => command === 'event' && name === 'page_view',
      )
    await React.act(async () => root.render(render(true)))
    expect(pageViews()).toHaveLength(1)
    // Withdrawal wipes GA cookies; the next granted session must get its
    // landing page_view or its landing page becomes "(not set)".
    await React.act(async () => root.render(render(false)))
    await React.act(async () => root.render(render(true)))
    expect(pageViews()).toHaveLength(2)
  })
})
