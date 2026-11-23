import type { ComponentType } from 'react'
import {
  createRequestHandler,
  Outlet,
  RouterContextProvider,
  type ActionFunction,
  type LoaderFunction,
  type ServerBuild,
} from 'react-router'
import { TooltipProvider } from '~/components/ui/tooltip'
import * as entry from '~/entry.server'

/**
 * The production request handler with the real entry.server and one page
 * route, without a build. Requests are what a browser sends before the client
 * has hydrated: plain documents and form posts. `Page` renders the route's
 * real component with fixed loader data; `action` is the route's real action.
 */
export function documentRequestHandler({
  path,
  Page,
  action,
  outletContext,
  layout,
}: {
  path: string
  Page: ComponentType
  action: ActionFunction
  outletContext?: unknown
  /**
   * A real layout route above the page, such as the Settings shell. Its
   * loader runs for the returned document and it provides the page's outlet
   * context in place of `outletContext`.
   */
  layout?: { loader: LoaderFunction; Component: ComponentType }
}) {
  function Root() {
    return (
      <html lang="en">
        <body>
          <TooltipProvider>
            <Outlet context={outletContext} />
          </TooltipProvider>
        </body>
      </html>
    )
  }
  const pageParent = layout ? 'layout' : 'root'
  const manifestRoute = {
    hasAction: false,
    hasLoader: false,
    hasClientAction: false,
    hasClientLoader: false,
    hasClientMiddleware: false,
    hasErrorBoundary: false,
    clientActionModule: undefined,
    clientLoaderModule: undefined,
    clientMiddlewareModule: undefined,
    hydrateFallbackModule: undefined,
  }
  const build: ServerBuild = {
    entry: { module: entry },
    assets: {
      entry: { module: '/entry.client.js', imports: [] },
      url: '/manifest.js',
      version: 'document-request',
      routes: {
        root: { ...manifestRoute, id: 'root', path: '', module: '/root.js' },
        ...(layout && {
          layout: {
            ...manifestRoute,
            id: 'layout',
            parentId: 'root',
            module: '/layout.js',
            hasLoader: true,
          },
        }),
        page: {
          ...manifestRoute,
          id: 'page',
          parentId: pageParent,
          path,
          module: '/page.js',
          hasAction: true,
        },
      },
    },
    publicPath: '/',
    assetsBuildDirectory: 'build/client',
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
    routes: {
      root: { id: 'root', path: '', module: { default: Root } },
      ...(layout && {
        layout: {
          id: 'layout',
          parentId: 'root',
          module: { default: layout.Component, loader: layout.loader },
        },
      }),
      page: {
        id: 'page',
        parentId: pageParent,
        path,
        module: { default: Page, action },
      },
    },
  }
  const handler = createRequestHandler(build, 'production')
  return (request: Request) => handler(request, new RouterContextProvider())
}

export function documentPost(url: string, fields: Record<string, string>) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
  })
}
