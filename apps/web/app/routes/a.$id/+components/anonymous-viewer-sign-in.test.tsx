// @vitest-environment happy-dom
import { createViewerHashSync } from '~/lib/viewer-hash'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, type ReactElement } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { TooltipProvider } from '~/components/ui/tooltip'
import {
  BrowserRouter,
  MemoryRouter,
  useLocation,
  useNavigate,
} from 'react-router'
import Viewer from '../+viewer'
import { PermissionDenied } from './permission-denied'
import { signIn, signOut } from '~/lib/auth-client'
import { viewerSignInHref } from '~/hooks/use-viewer-hash'
import { describe, expect, test, vi } from 'vitest'
import { AnonymousViewerSignInControl } from './anonymous-viewer-sign-in'

describe('AnonymousViewerSignInControl', () => {
  const href = 'https://artifactshare.com/sign-in?next=%2Fa%2Fs1'

  test('uses a link so Google can decorate an analytics-enabled transition', () => {
    const html = renderToStaticMarkup(
      <AnonymousViewerSignInControl
        href={href}
        label="Sign in"
        shouldLoadAnalytics
      />,
    )

    expect(html).toContain(`href="${href}"`)
    expect(html).toContain('text-foreground hover:bg-accent')
    expect(html).toContain('data-slot="button"')
  })

  test('uses scripted navigation when analytics is disabled', () => {
    const control = AnonymousViewerSignInControl({
      href,
      label: 'Sign in',
      shouldLoadAnalytics: false,
    }) as ReactElement<{ onClick: () => void }>
    const html = renderToStaticMarkup(control)

    expect(html).toMatch(/<button[^>]*>Sign in<\/button>/)
    expect(html).not.toContain('href=')

    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign } })
    try {
      control.props.onClick()
      expect(assign).toHaveBeenCalledWith(href)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

test('scripted sign-in reads the fragment at activation and keeps the trusted app origin', () => {
  const href =
    'https://example.test/sign-in?next=%2Fa%2Fabc123def4%3Fversion%3Dv1'
  const control = AnonymousViewerSignInControl({
    href,
    label: 'Sign in',
    shouldLoadAnalytics: false,
  }) as ReactElement<{ onClick: () => void }>
  const assign = vi.fn()
  vi.stubGlobal('window', {
    location: { hash: '#from=2026-07-11&media=video', assign },
  })
  try {
    control.props.onClick()
    const url = new URL(assign.mock.calls[0][0])
    expect(url.origin).toBe('https://example.test')
    expect(url.pathname).toBe('/sign-in')
    expect(url.hash).toBe('')
    expect(url.searchParams.get('next')).toBe(
      '/a/abc123def4?version=v1&as_hash=%23from%3D2026-07-11%26media%3Dvideo',
    )
  } finally {
    vi.unstubAllGlobals()
  }
})

vi.mock('react-router', async (original) => ({
  ...(await original<typeof import('react-router')>()),
  useFetcher: () => ({ state: 'idle' }),
  useRouteLoaderData: () => ({
    locale: 'en',
    analyticsConsent: { shouldLoadAnalytics: false },
  }),
}))
vi.mock('~/lib/auth-client', () => ({
  signIn: { social: vi.fn() },
  signOut: vi.fn(),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

test('hydrated consent-enabled sign-in anchors encode the fragment inside next', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const sync = createViewerHashSync()
  const previousUrl = window.location.href
  window.history.replaceState(null, '', '/#q=abc')
  const view = (
    <AnonymousViewerSignInControl
      href="https://example.test/sign-in?next=%2Fa%2Fabc123def4"
      label="Sign in"
      shouldLoadAnalytics
    />
  )
  host.innerHTML = renderToStaticMarkup(view)
  let root!: ReturnType<typeof hydrateRoot>
  try {
    await act(async () => {
      root = hydrateRoot(host, view)
    })
    const link = host.querySelector('a')!
    expect(new URL(link.href).origin).toBe('https://example.test')
    expect(new URL(link.href).searchParams.get('next')).toBe(
      '/a/abc123def4?as_hash=%23q%3Dabc',
    )
    expect(new URL(link.href).hash).toBe('')
    await act(async () => {
      sync.accept('#latest')
    })
    expect(window.location.hash).toBe('#q=abc')
    expect(new URL(link.href).searchParams.get('next')).toBe(
      '/a/abc123def4?as_hash=%23latest',
    )
  } finally {
    sync.clear()
    await act(async () => root.unmount())
    host.remove()
    window.history.replaceState(null, '', previousUrl)
  }
})

test('preauth email and both providers keep the canonical path/query with the client fragment', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const previousUrl = window.location.href
  window.history.replaceState(null, '', '/#initial')
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <MemoryRouter>
            <Viewer
              loaderData={{
                kind: 'preauth',
                canonicalUrl: 'https://example.test/a/abc123def4?version=v1',
                artifact: {
                  id: 'abc123def4',
                  name: null,
                  derivedTitle: null,
                  titleOverride: null,
                  description: null,
                },
              }}
            />
          </MemoryRouter>
        </TooltipProvider>,
      ),
    )
    const email = host.querySelector<HTMLAnchorElement>(
      'a[href*="method=email"]',
    )!
    expect(new URL(email.href).searchParams.get('next')).toBe(
      '/a/abc123def4?version=v1&as_hash=%23initial',
    )
    window.history.replaceState(null, '', '#activated')
    const providers = Array.from(host.querySelectorAll('button')).filter(
      (button) =>
        button.textContent?.includes('Google') ||
        button.textContent?.includes('Microsoft'),
    )
    expect(providers).toHaveLength(2)
    for (const button of providers) {
      await act(async () => button.click())
      expect(
        vi.mocked(signIn.social).mock.calls.at(-1)?.[0].callbackURL,
      ).not.toContain('#')
      expect(vi.mocked(signIn.social).mock.calls.at(-1)?.[0]).toMatchObject({
        callbackURL: '/a/abc123def4?version=v1&as_hash=%23activated',
        errorCallbackURL:
          '/sign-in?next=%2Fa%2Fabc123def4%3Fversion%3Dv1%26as_hash%3D%2523activated',
      })
    }
  } finally {
    await act(async () => root.unmount())
    host.remove()
    window.history.replaceState(null, '', previousUrl)
  }
})

test('fragment return targets preserve internal-path validation', () => {
  const url = new URL(
    viewerSignInHref(
      'https://example.test/sign-in?next=%2F%2Fexample.com',
      '#q',
    ),
  )
  expect(url.origin).toBe('https://example.test')
  expect(url.searchParams.get('next')).toBe('/?as_hash=%23q')
})

test('client callback restoration updates the router even when preauth has no frame', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const previousUrl = window.location.href
  window.history.replaceState(
    null,
    '',
    '/a/abc123def4?version=v1&as_hash=%23restored',
  )
  function RouterLocation() {
    const location = useLocation()
    const navigate = useNavigate()
    return (
      <button
        data-location={location.search + location.hash}
        onClick={() =>
          void navigate({ search: location.search, hash: location.hash })
        }
      >
        Navigate again
      </button>
    )
  }
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <BrowserRouter>
            <RouterLocation />
            <Viewer
              loaderData={{
                kind: 'preauth',
                canonicalUrl: 'https://example.test/a/abc123def4?version=v1',
                artifact: {
                  id: 'abc123def4',
                  name: null,
                  derivedTitle: null,
                  titleOverride: null,
                  description: null,
                },
              }}
            />
          </BrowserRouter>
        </TooltipProvider>,
      ),
    )
    expect(host.querySelector('iframe')).toBeNull()
    const again = host.querySelector<HTMLButtonElement>('[data-location]')!
    expect(again.dataset.location).toBe('?version=v1#restored')
    expect(window.location.search + window.location.hash).toBe(
      '?version=v1#restored',
    )
    const email = host.querySelector<HTMLAnchorElement>(
      'a[href*="method=email"]',
    )!
    expect(new URL(email.href).searchParams.get('next')).toBe(
      '/a/abc123def4?version=v1&as_hash=%23restored',
    )
    await act(async () => again.click())
    expect(window.location.search + window.location.hash).toBe(
      '?version=v1#restored',
    )
  } finally {
    await act(async () => root.unmount())
    host.remove()
    window.history.replaceState(null, '', previousUrl)
  }
})

test('switch account retains the share query and live fragment in next', async () => {
  const previousUrl = window.location.href
  window.history.replaceState(
    null,
    '',
    '/a/abc123def4?version=v1&comment=c1#filter',
  )
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () =>
      root.render(
        <TooltipProvider>
          <MemoryRouter>
            <PermissionDenied
              variant="external"
              artifactId="abc123def4"
              user={{
                id: 'u1',
                email: 'viewer@example.test',
                name: null,
                image: null,
                initial: 'V',
              }}
              emailVerified
              requestStatus={null}
            />
          </MemoryRouter>
        </TooltipProvider>,
      ),
    )
    const button = Array.from(host.querySelectorAll('button')).find(
      (item) => item.textContent === 'Switch account',
    )!
    expect(button).toBeDefined()
    await act(async () => button.click())
    expect(signOut).toHaveBeenCalled()
    const destination = new URL(window.location.href)
    expect(destination.pathname).toBe('/')
    expect(destination.searchParams.get('next')).toBe(
      '/a/abc123def4?version=v1&comment=c1&as_hash=%23filter',
    )
    expect(destination.hash).toBe('')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    window.history.replaceState(null, '', previousUrl)
  }
})

test('callback SSR and hydration retain the same viewer content before query cleanup', async () => {
  const previousUrl = window.location.href
  const callback = '/a/abc123def4?version=v1&as_hash=%23restored'
  window.history.replaceState(null, '', callback)
  const view = (
    <TooltipProvider>
      <MemoryRouter initialEntries={[callback]}>
        <Viewer
          loaderData={{
            kind: 'preauth',
            canonicalUrl: 'https://example.test/a/abc123def4?version=v1',
            artifact: {
              id: 'abc123def4',
              name: null,
              derivedTitle: null,
              titleOverride: null,
              description: null,
            },
          }}
        />
      </MemoryRouter>
    </TooltipProvider>
  )
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(view)
  document.body.appendChild(host)
  const heading = host.querySelector('h1')
  expect(heading).not.toBeNull()
  const onRecoverableError = vi.fn()
  let root!: ReturnType<typeof hydrateRoot>
  try {
    await act(async () => {
      root = hydrateRoot(host, view, { onRecoverableError })
    })
    expect(host.querySelector('h1')).toBe(heading)
    expect(onRecoverableError).not.toHaveBeenCalled()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    window.history.replaceState(null, '', previousUrl)
  }
})
