import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import {
  createBrowserRouter,
  createRequestHandler,
  UNSAFE_createClientRoutes,
  UNSAFE_getTurboStreamSingleFetchDataStrategy,
  type UNSAFE_AssetsManifest,
  type ServerBuild,
  createStaticHandler,
  createStaticRouter,
  Outlet,
  RouterProvider,
  StaticRouterProvider,
  useLoaderData,
} from 'react-router'
import { afterEach, expect, test, vi } from 'vitest'
import { ViewerTimezone } from '~/components/app/viewer-timezone'
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

function RootLayout() {
  return (
    <>
      <ViewerTimezone />
      <Outlet />
    </>
  )
}

const routes = [
  {
    id: 'root',
    path: '/',
    loader: () => ({ locale: 'en', user: null }),
    Component: RootLayout,
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

// Use the installed framework's client routes, single-fetch URL generation and
// server encoder. The browser harness cannot import the application's Worker;
// app.test.ts separately checks this exact request path at that boundary.
const routeEntries = [routes[0], ...routes[0].children]
const manifest: UNSAFE_AssetsManifest = {
  entry: { module: '/entry.js', imports: [] },
  url: '/manifest.js',
  version: 'synthetic',
  routes: Object.fromEntries(
    routeEntries.map((route) => [
      route.id,
      {
        id: route.id,
        parentId: route.id === 'root' ? undefined : 'root',
        path: 'path' in route ? route.path : undefined,
        index: 'index' in route ? route.index : undefined,
        module: `/routes/${route.id}.js`,
        hasLoader: true,
        hasAction: false,
        hasClientLoader: false,
        hasClientAction: false,
        hasClientMiddleware: false,
        hasErrorBoundary: false,
        clientActionModule: undefined,
        clientLoaderModule: undefined,
        clientMiddlewareModule: undefined,
        hydrateFallbackModule: undefined,
      },
    ]),
  ),
}
const routeModules = Object.fromEntries(
  routeEntries.map((route) => [
    route.id,
    {
      default: route.Component,
    },
  ]),
)
const serverBuild: ServerBuild = {
  entry: { module: { default: () => new Response('unused document entry') } },
  routes: Object.fromEntries(
    routeEntries.map((route) => [
      route.id,
      {
        ...manifest.routes[route.id]!,
        module: { default: route.Component, loader: route.loader },
      },
    ]),
  ),
  assets: manifest,
  publicPath: '/',
  assetsBuildDirectory: 'assets',
  future: {},
  ssr: true,
  isSpaMode: false,
  prerender: [],
  routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
}

let root: Root | undefined
let router: ReturnType<typeof createBrowserRouter> | undefined
let container: HTMLDivElement | undefined
const initialUrl = window.location.href
const initialState = window.history.state

afterEach(() => {
  root?.unmount()
  router?.dispose()
  container?.remove()
  document.cookie = '__as_tz=; Path=/; Max-Age=0'
  vi.restoreAllMocks()
  window.history.replaceState(initialState, '', initialUrl)
})

test.each(['/', '/a/abc123def4'])(
  'hydrates the shared viewer at %s without an intermediate URL or lost state',
  async (pathname) => {
    document.cookie = '__as_tz=; Path=/; Max-Age=0'
    const resolved = Intl.DateTimeFormat().resolvedOptions()
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...resolved,
      timeZone: 'Asia/Tokyo',
    })
    const dataHandler = createRequestHandler(serverBuild, 'test')
    const fetchData = vi
      .spyOn(window, 'fetch')
      .mockImplementation(async (input, init) => {
        expect(document.cookie).toContain('__as_tz=Asia%2FTokyo')
        return dataHandler(new Request(input, init))
      })
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

    const clientRoutes = UNSAFE_createClientRoutes(
      manifest.routes,
      routeModules,
      context,
      true,
      false,
    )
    router = createBrowserRouter(clientRoutes, {
      hydrationData: context,
      dataStrategy: UNSAFE_getTurboStreamSingleFetchDataStrategy(
        () => router!,
        manifest,
        routeModules,
        true,
      ),
    })
    const onRecoverableError = vi.fn()
    root = hydrateRoot(container, <RouterProvider router={router} />, {
      onRecoverableError,
    })
    await vi.waitFor(() => expect(router?.state.initialized).toBe(true))
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )

    await vi.waitFor(() => {
      expect(fetchData).toHaveBeenCalledTimes(1)
      expect(router?.state.revalidation).toBe('idle')
    })
    const dataUrl = new URL(String(fetchData.mock.calls[0]![0]))
    expect(dataUrl.pathname).toBe(
      pathname === '/' ? '/_.data' : `${pathname}.data`,
    )
    expect(dataUrl.search).toBe(new URL(url, window.location.origin).search)
    expect(dataUrl.hash).toBe('')
    expect(router.state.errors).toBeNull()
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

    // A document reload keeps the cookie, so mounting again must not fetch.
    root.unmount()
    router.dispose()
    container.innerHTML = renderToString(
      <StaticRouterProvider
        router={serverRouter}
        context={context}
        hydrate={false}
      />,
    )
    router = createBrowserRouter(clientRoutes, {
      hydrationData: context,
      dataStrategy: UNSAFE_getTurboStreamSingleFetchDataStrategy(
        () => router!,
        manifest,
        routeModules,
        true,
      ),
    })
    root = hydrateRoot(container, <RouterProvider router={router} />)
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    expect(fetchData).toHaveBeenCalledTimes(1)
    expect(container.querySelector('main')).not.toBeNull()
    expect(router.state.errors).toBeNull()
    expect(
      window.location.pathname + window.location.search + window.location.hash,
    ).toBe(url)
  },
)
