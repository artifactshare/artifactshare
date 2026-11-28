import { env } from 'cloudflare:workers'
import { documentLocale } from '~/lib/document-locale.server'
import { linkDomainContext, userContext } from '~/middleware/context'
import {
  RequestLocaleContext,
  ApplicationOriginContext,
} from '~/lib/error-document'
import {
  logErrorDiagnostic,
  routerRequestContext,
} from '~/lib/error-diagnostics.server'
import type {
  EntryContext,
  HandleErrorFunction,
  InstrumentationHandlerResult,
  ServerInstrumentation,
} from 'react-router'
import {
  isRouteErrorResponse,
  ServerRouter,
  type RouterContextProvider,
} from 'react-router'
import { isbot } from 'isbot'
import { renderToReadableStream } from 'react-dom/server'

const reported = new WeakMap<Request, Set<unknown>>()

export const instrumentations: ServerInstrumentation[] = [
  {
    route(route) {
      async function reportRouteError(
        run: () => Promise<InstrumentationHandlerResult>,
        { context }: { context: Pick<RouterContextProvider, 'get'> },
      ) {
        const result = await run()
        const request = context.get(routerRequestContext)
        if (result.status === 'error' && request) {
          report(result.error, request, route.id)
        }
      }
      route.instrument({
        loader: reportRouteError,
        action: reportRouteError,
        middleware: reportRouteError,
      })
    },
  },
]

function report(error: unknown, request: Request, routeId?: string) {
  if (
    request.signal.aborted ||
    (isRouteErrorResponse(error) && error.status < 500) ||
    (error instanceof Response && error.status < 500)
  )
    return
  const errors = reported.get(request) ?? new Set<unknown>()
  if (errors.has(error)) return
  errors.add(error)
  reported.set(request, errors)
  logErrorDiagnostic('router.error', error, request.method, routeId)
}

export const handleError: HandleErrorFunction = (error, { request }) =>
  report(error, request)

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  const userAgent = request.headers.get('user-agent')

  const requestLocale = documentLocale(request, {
    user: loadContext.get(userContext),
    linkDomain: loadContext.get(linkDomainContext) !== null,
  })
  const body = await renderToReadableStream(
    <RequestLocaleContext.Provider value={requestLocale}>
      <ApplicationOriginContext.Provider value={env.BETTER_AUTH_URL}>
        <ServerRouter context={routerContext} url={request.url} />
      </ApplicationOriginContext.Provider>
    </RequestLocaleContext.Provider>,
    {
      onError(error: unknown) {
        responseStatusCode = 500
        report(error, request)
      },
    },
  )

  // Ensure requests from bots and SPA Mode renders wait for all content to load before responding
  // https://react.dev/reference/react-dom/server/renderToPipeableStream#waiting-for-all-content-to-load-for-crawlers-and-static-generation
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady
  }

  responseHeaders.set('Content-Type', 'text/html')
  return new Response(body, {
    headers: responseHeaders,
    status: responseStatusCode,
  })
}
