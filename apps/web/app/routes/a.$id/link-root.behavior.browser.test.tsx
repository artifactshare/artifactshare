import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import {
  createBrowserRouter,
  createStaticHandler,
  createStaticRouter,
  Outlet,
  RouterProvider,
  StaticRouterProvider,
  useLoaderData,
} from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import Viewer from './+viewer'

// Import the real shared viewer without mocking any server modules. A runtime
// server dependency here must fail in the browser, as it would in the home route.
const viewerData = {
  kind: 'unavailable' as const,
  user: null,
  appOrigin: 'https://example.test',
}

function ViewerPage() {
  return <Viewer loaderData={useLoaderData<typeof viewerData>()} />
}

const routes = [
  {
    id: 'root',
    path: '/',
    loader: () => ({ locale: 'en', user: null }),
    Component: Outlet,
    children: [
      {
        id: 'home',
        index: true,
        loader: () => viewerData,
        Component: ViewerPage,
      },
      {
        id: 'viewer',
        path: 'a/:id',
        loader: () => viewerData,
        Component: ViewerPage,
      },
    ],
  },
]

let root: Root | undefined
let router: ReturnType<typeof createBrowserRouter> | undefined
let container: HTMLDivElement | undefined
const initialUrl = window.location.href
const initialState = window.history.state

afterEach(() => {
  root?.unmount()
  router?.dispose()
  container?.remove()
  vi.restoreAllMocks()
  window.history.replaceState(initialState, '', initialUrl)
})

test.each(['/', '/a/abc123def4'])(
  'hydrates the shared viewer at %s without an intermediate URL or lost state',
  async (pathname) => {
    const url = `${pathname}?panel=comments&tag=one&tag=two&version=old#section`
    window.history.replaceState({ usr: { returnTo: '/files' } }, '', url)
    const historyLength = window.history.length
    const push = vi.spyOn(window.history, 'pushState')
    const replace = vi.spyOn(window.history, 'replaceState')
    const handler = createStaticHandler(routes)
    // The Worker filters version for loaders while the browser retains the
    // original document URL. Hashes are only available in the browser.
    const serverUrl = new URL(url, window.location.origin)
    serverUrl.searchParams.delete('version')
    serverUrl.hash = ''
    const context = await handler.query(new Request(serverUrl))
    if (context instanceof Response) throw new Error('Unexpected response')
    const serverRouter = createStaticRouter(handler.dataRoutes, context)
    container = document.createElement('div')
    container.innerHTML = renderToString(
      <StaticRouterProvider
        router={serverRouter}
        context={context}
        hydrate={false}
      />,
    )
    document.body.appendChild(container)
    const serverMain = container.querySelector('main')
    expect(serverMain).not.toBeNull()
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe(url)

    router = createBrowserRouter(routes, { hydrationData: context })
    const onRecoverableError = vi.fn()
    root = hydrateRoot(container, <RouterProvider router={router} />, {
      onRecoverableError,
    })
    await vi.waitFor(() => expect(router?.state.initialized).toBe(true))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )

    expect(container.querySelector('main')).toBe(serverMain)
    expect(onRecoverableError).not.toHaveBeenCalled()
    expect(router.state.matches.at(-1)?.route.id).toBe(
      pathname === '/' ? 'home' : 'viewer',
    )
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe(url)
    expect(window.history.state.usr).toEqual({ returnTo: '/files' })
    expect(window.history.length).toBe(historyLength)
    expect(push).not.toHaveBeenCalled()
    // Router initialization may add its history index, but must not rewrite URL.
    expect(replace.mock.calls.every((call) => call[2] === undefined)).toBe(true)
  },
)
