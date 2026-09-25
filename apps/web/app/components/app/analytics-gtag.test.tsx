// @vitest-environment happy-dom
import React, { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useNavigate } from 'react-router'
import { trackEvent } from '~/lib/analytics/track.client'

import { AnalyticsGtag } from './analytics-gtag'

// Model GA's global parameters and its document-title fallback for each hit.
function recordHits() {
  const globals: Record<string, unknown> = {}
  const hits: Record<string, unknown>[] = []
  const gtag = vi.fn((command: string, name: unknown, params?: unknown) => {
    if (command === 'set') Object.assign(globals, name)
    if (command === 'event') {
      hits.push({
        page_title: document.title,
        ...globals,
        ...Object(params),
        event: name,
      })
    }
  })
  ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
  return { gtag, hits }
}

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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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

  it('queues page fields before consent, js, user_id, config, and page_view', async () => {
    const gtag = vi.fn()
    ;(window as unknown as { gtag: typeof gtag }).gtag = gtag
    await React.act(async () => {
      root.render(
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId="u-hash"
          />
        </MemoryRouter>,
      )
    })
    expect(gtag.mock.calls.map(([command]) => command)).toEqual([
      'set',
      'consent',
      'js',
      'set',
      'config',
      'event',
    ])
    expect(gtag).toHaveBeenLastCalledWith('event', 'page_view', {
      page_location: expect.stringContaining('http'),
      page_title: 'Home · Artifact Share',
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
      'set',
      'consent',
      'js',
      'set',
      'config',
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
      <MemoryRouter
        initialEntries={[
          window.location.pathname +
            window.location.search +
            window.location.hash,
        ]}
      >
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
      'set',
      'consent',
      'js',
      'set',
      'config',
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
        <MemoryRouter
          initialEntries={[
            window.location.pathname +
              window.location.search +
              window.location.hash,
          ]}
        >
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
      <MemoryRouter
        initialEntries={[
          window.location.pathname +
            window.location.search +
            window.location.hash,
        ]}
      >
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
      <MemoryRouter
        initialEntries={[
          window.location.pathname +
            window.location.search +
            window.location.hash,
        ]}
      >
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
  it.each([
    ['/', 'Home'],
    ['/a/private123', 'Artifact'],
    ['/a/%53ynthetic?comment=secret#name', 'Artifact'],
    ['/files', 'Files'],
    ['/recent', 'Recent'],
    ['/activity', 'Activity'],
    ['/projects', 'Projects'],
    ['/projects/archived', 'Archived projects'],
    ['/projects/name', 'Project'],
    ['/projects/name/files', 'Project files'],
    ['/projects/name/activity', 'Project activity'],
    ['/projects/name/slack', 'Project integration'],
    ['/settings', 'Settings'],
    ['/settings/name', 'Settings'],
    ['/access-requests', 'Access requests'],
    ['/sign-in', 'Sign in'],
    ['/device', 'Device authorization'],
    ['/consent', 'Consent'],
    ['/connect/slack', 'Integration'],
    ['/integrations/slack/install', 'Integration'],
    ['/projects/name/slack/install', 'Integration'],
    ['/ops/link/name', 'Link review'],
    ['/pricing', 'Pricing'],
    ['/ja/about', 'About'],
    ['/en', 'Home'],
    ['/ja/guides/cli', 'Guide'],
    ['/guides/workspace-admin', 'Guide'],
    ['/guides/workspace-owner', 'Guide'],
    ['/guides/link-sharing', 'Guide'],
    ['/guides/private-mobile-design-handoff', 'Guide'],
    ['/en/updates/name', 'Updates'],
    ['/updates', 'Updates'],
    ['/privacy', 'Privacy'],
    ['/ja/terms', 'Terms'],
    ['/tokushoho', 'Legal'],
    ['/start', 'Start'],
    ['/share-with-ai', 'Share with AI'],
    ['/connect', 'Integration'],
    ['/unknown/name?title=secret#secret', null],
    ['/fr/pricing', null],
    ['/dev/gallery', null],
    ['/%70ricing', null],
    ['/a/name/extra', null],
    ['/ja/projects/name', null],
    ['/guides/unknown', null],
  ])('uses only a fixed title for %s', async (path, label) => {
    window.history.replaceState({}, '', path)
    document.title = 'Synthetic private draft · Artifact Share'
    const { hits, gtag } = recordHits()
    await React.act(async () =>
      root.render(
        <MemoryRouter initialEntries={[path]}>
          <AnalyticsGtag
            shouldLoadAnalytics
            measurementId="G-TEST"
            userId="u-hash"
          />
        </MemoryRouter>,
      ),
    )
    trackEvent('copy_link_succeeded')
    const title = label ? `${label} · Artifact Share` : 'Artifact Share'
    expect(hits).toHaveLength(2)
    expect(hits.every((hit) => hit.page_title === title)).toBe(true)
    expect(gtag.mock.calls[0]).toEqual([
      'set',
      expect.objectContaining({ page_title: title }),
    ])
    expect(JSON.stringify(hits)).not.toContain('Synthetic private draft')
    expect(document.title).toBe('Synthetic private draft · Artifact Share')
  })

  it('detects the raw document title when global title pinning is absent', () => {
    document.title = 'Synthetic private draft · Artifact Share'
    const { gtag, hits } = recordHits()
    gtag('event', 'copy_link_succeeded', {})
    expect(hits[0].page_title).toBe(document.title)
  })

  it('protects private landing hits, later title changes, and consent re-grant', async () => {
    window.history.replaceState({}, '', '/a/private123')
    document.title = 'Synthetic private draft · Artifact Share'
    const { gtag, hits } = recordHits()
    function PassiveTracker({ allowed }: { allowed: boolean }) {
      useEffect(() => {
        trackEvent('artifact_view', {
          artifact_id: 'private123',
          visibility: 'private',
        })
        trackEvent('copy_link_succeeded')
      }, [allowed])
      return null
    }
    const render = (allowed: boolean) => (
      <MemoryRouter initialEntries={['/a/private123']}>
        <PassiveTracker allowed={allowed} />
        <AnalyticsGtag
          shouldLoadAnalytics={allowed}
          measurementId="G-TEST"
          userId="u-hash"
        />
      </MemoryRouter>
    )
    await React.act(async () => root.render(render(true)))
    expect(hits.map((hit) => hit.event)).toEqual([
      'artifact_view',
      'copy_link_succeeded',
      'page_view',
    ])
    expect(gtag).toHaveBeenCalledWith('event', 'artifact_view', {
      artifact_id: 'private123',
      visibility: 'private',
    })
    expect(gtag).toHaveBeenCalledWith('event', 'page_view', {
      page_location: window.location.href,
      page_title: 'Artifact · Artifact Share',
    })
    document.title = 'Synthetic renamed draft · Artifact Share'
    trackEvent('copy_link_succeeded')
    await React.act(async () => root.render(render(false)))
    expect(hits).toHaveLength(4)
    gtag.mockClear()
    await React.act(async () => root.render(render(true)))
    expect(hits).toHaveLength(7)
    expect(gtag.mock.calls[0]).toEqual([
      'set',
      expect.objectContaining({ page_title: 'Artifact · Artifact Share' }),
    ])
    expect(gtag.mock.calls[1][0]).toBe('consent')
    for (const hit of hits) {
      expect(hit.page_title).toBe('Artifact · Artifact Share')
      expect(hit.user_id).toBe('u-hash')
    }
    expect(JSON.stringify(hits)).not.toContain('Synthetic')
    expect(JSON.stringify(gtag.mock.calls)).not.toContain('Synthetic')
  })

  it.each(['same-origin', 'external'])(
    'updates titles on SPA push, replace, and pop with %s referrers',
    async (kind) => {
      const origin = window.location.origin
      const referrer =
        kind === 'same-origin'
          ? `${origin}/device?user_code=SECRET&utm_source=x#secret`
          : 'https://example.com/source?q=external#section'
      const referrerSpy = vi
        .spyOn(document, 'referrer', 'get')
        .mockReturnValue(referrer)
      const { hits } = recordHits()
      let navigate: ReturnType<typeof useNavigate>
      function Navigation() {
        navigate = useNavigate()
        return null
      }
      await React.act(async () =>
        root.render(
          <MemoryRouter>
            <Navigation />
            <AnalyticsGtag
              shouldLoadAnalytics
              measurementId="G-TEST"
              userId="u-hash"
            />
          </MemoryRouter>,
        ),
      )
      expect(hits[0].page_referrer).toBe(
        kind === 'same-origin' ? `${origin}/device?utm_source=x` : referrer,
      )
      let previous = `${origin}/`
      for (const [path, title] of [
        ['/a/private123?comment=name#comment', 'Artifact'],
        ['/projects/name/files', 'Project files'],
        ['/settings/name', 'Settings'],
        ['/ja/pricing', 'Pricing'],
        ['/unknown/name', null],
      ] as const) {
        await React.act(async () => {
          window.history.pushState({}, '', path)
          await navigate(path)
        })
        trackEvent('copy_link_succeeded')
        const hit = hits.at(-1)!
        expect(hit.page_title).toBe(
          title ? `${title} · Artifact Share` : 'Artifact Share',
        )
        expect(hit.page_referrer).toBe(previous)
        previous = `${origin}${path.split(/[?#]/)[0]}`
      }
      expect(hits.filter((hit) => hit.event === 'page_view')).toHaveLength(6)
      await React.act(async () => {
        window.history.replaceState({}, '', '/unknown/name?cleanup=secret')
        await navigate('/unknown/name?cleanup=secret', { replace: true })
      })
      expect(hits.filter((hit) => hit.event === 'page_view')).toHaveLength(6)
      await React.act(async () => {
        window.history.replaceState({}, '', '/ja/pricing')
        await navigate(-1)
      })
      expect(hits.at(-1)).toMatchObject({
        page_title: 'Pricing · Artifact Share',
        page_referrer: `${origin}/unknown/name`,
      })
      expect(hits.filter((hit) => hit.event === 'page_view')).toHaveLength(7)
      referrerSpy.mockRestore()
    },
  )
})
