import {
  createRequestHandler,
  UNSAFE_createClientRoutes,
  UNSAFE_getTurboStreamSingleFetchDataStrategy,
  type ActionFunction,
  type DataRouter,
  type DataStrategyFunction,
  type MiddlewareFunction,
  type UNSAFE_AssetsManifest,
  type UNSAFE_RouteModules,
} from 'react-router'

type Module = NonNullable<UNSAFE_RouteModules[string]>
export function settingsSingleFetch({
  path,
  Component,
  Boundary,
  clientAction,
  action,
  mode = 'development',
  middleware,
  getRouter,
  fetchResponse,
}: {
  path: string
  Component: Module['default']
  Boundary?: Module['ErrorBoundary']
  clientAction: Module['clientAction']
  action: ActionFunction
  mode?: 'development' | 'production'
  middleware?: MiddlewareFunction<Response>[]
  getRouter: () => DataRouter
  fetchResponse: (
    request: Request,
    handle: (request: Request) => Promise<Response>,
  ) => Promise<Response>
}) {
  const manifest: UNSAFE_AssetsManifest = {
    entry: { module: '', imports: [] },
    url: '',
    version: 'test',
    routes: {
      settings: {
        id: 'settings',
        path,
        module: '',
        hasAction: true,
        hasLoader: true,
        hasClientLoader: true,
        hasClientAction: true,
        hasClientMiddleware: false,
        hasErrorBoundary: true,
        clientActionModule: undefined,
        clientLoaderModule: undefined,
        clientMiddlewareModule: undefined,
        hydrateFallbackModule: undefined,
      },
    },
  }
  const modules: UNSAFE_RouteModules = {
    settings: {
      default: Component,
      clientAction,
      clientLoader: () => null,
      ErrorBoundary: Boundary,
    },
  }
  const handler = createRequestHandler(
    {
      entry: {
        module: { default: () => new Response(), handleError: () => {} },
      },
      assets: manifest,
      publicPath: '/',
      assetsBuildDirectory: 'build/client',
      future: {},
      ssr: true,
      isSpaMode: false,
      prerender: [],
      routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
      routes: {
        settings: {
          id: 'settings',
          path,
          module: { default: () => null, action, middleware },
        },
      },
    },
    mode,
  )

  const transport = UNSAFE_getTurboStreamSingleFetchDataStrategy(
    getRouter,
    manifest,
    modules,
    false,
    (request) => fetchResponse(request, handler),
  )
  const routes = UNSAFE_createClientRoutes(
    manifest.routes,
    modules,
    null,
    false,
    false,
  )
  const dataStrategy: DataStrategyFunction = (args) =>
    args.request.method === 'POST'
      ? transport(args)
      : args.runClientMiddleware(async (inner) =>
          Object.fromEntries(
            await Promise.all(
              inner.matches
                .filter((match) => match.shouldCallHandler())
                .map(async (match) => [match.route.id, await match.resolve()]),
            ),
          ),
        )
  return { routes, dataStrategy }
}
