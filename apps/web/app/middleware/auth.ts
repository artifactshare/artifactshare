import { redirect, type MiddlewareFunction } from 'react-router'
import {
  AUTH_SESSION_DATA_COOKIE_NAMES,
  AUTH_SESSION_TOKEN_COOKIE_NAMES,
} from '~/lib/auth-cookies'
import {
  getSessionUser,
  getSessionUserFromBearer,
  readBearerSessionToken,
} from '~/services/auth.server'
import { resolveCliAuthorityBySessionToken } from '~/services/cli-authority.server'
import { isApiToken } from '~/services/api-tokens.server'
import {
  allowsCliOperation,
  cliScopeDeniedResponse,
} from '~/lib/cli-agent-operations'
import { authSourceContext, cliAuthorityContext, userContext } from './context'

const AUTH_OBSERVATION_SAMPLE_RATE = 0.05

type AuthObservationOptions = {
  bearerChecked?: boolean
  bearerResolved?: boolean
  cookieUserResolved: boolean
  phase: 'session' | 'bearer_api'
}

/**
 * Resolve the session user once per request and stash it in context.
 * Apply at the root so child middlewares + loaders share a single lookup.
 */
export const sessionMiddleware: MiddlewareFunction = async (
  { request, context, url },
  next,
) => {
  const user = await getSessionUser(request)

  context.set(userContext, user)
  logAuthObservation(
    request,
    {
      cookieUserResolved: Boolean(user),
      phase: 'session',
    },
    url,
  )
  return next()
}

/**
 * Protect a route subtree: throw redirect to / if no session.
 * Must run after `sessionMiddleware` (declared higher in the tree).
 */
export const requireUserMiddleware: MiddlewareFunction = ({ context, url }) => {
  if (context.get(userContext)) return
  throw redirect(`/?next=${encodeURIComponent(url.pathname + url.search)}`)
}

/**
 * Same as `requireUserMiddleware` but returns 401 JSON for API routes —
 * fetchers don't need to follow a redirect to /.
 */
export const requireUserApiMiddleware: MiddlewareFunction = ({ context }) => {
  if (context.get(userContext)) return
  throw new Response('Unauthorized', { status: 401 })
}

/**
 * API routes that accept CLI bearer session tokens in addition to cookies.
 * Cookie sessions are resolved by root `sessionMiddleware`, but an explicit
 * bearer credential takes precedence. Never fall back to a cookie when bearer
 * validation fails: doing so could upgrade a scoped CLI request to the wider
 * authority of a browser session.
 */
export const requireUserApiWithBearerMiddleware: MiddlewareFunction = async (
  { request, context, url },
  next,
) => {
  let bearerChecked = false
  let bearerResolved = false
  const bearerToken = readBearerSessionToken(request)
  if (bearerToken) {
    bearerChecked = true
    const bearerUser = await getSessionUserFromBearer(request)
    const authority = bearerUser
      ? isApiToken(bearerToken)
        ? { kind: 'unrestricted' as const }
        : await resolveCliAuthorityBySessionToken(bearerToken)
      : null
    bearerResolved = Boolean(bearerUser && authority)
    if (bearerUser && authority) {
      context.set(userContext, bearerUser)
      context.set(authSourceContext, 'bearer')
      context.set(cliAuthorityContext, authority)
      if (!allowsCliOperation(authority, request.method, url.pathname)) {
        throw cliScopeDeniedResponse()
      }
    } else {
      context.set(userContext, null)
      context.set(authSourceContext, null)
      context.set(cliAuthorityContext, null)
    }
  } else if (context.get(userContext)) {
    context.set(authSourceContext, 'cookie')
  } else {
    context.set(authSourceContext, null)
  }
  if (hasBearerAuth(request)) {
    logAuthObservation(
      request,
      {
        bearerChecked,
        bearerResolved,
        cookieUserResolved:
          Boolean(context.get(userContext)) && !bearerResolved,
        phase: 'bearer_api',
      },
      url,
    )
  }
  if (context.get(userContext)) return next()
  throw new Response('Unauthorized', { status: 401 })
}

export function authObservationPayload(
  request: Request,
  options: AuthObservationOptions,
  url = new URL(request.url),
) {
  const cookieHints = authCookieHints(request)
  const hasBearer = hasBearerAuth(request)
  const cookieCacheState = cookieHints.hasSessionToken
    ? cookieHints.hasSessionData
      ? 'cookie_cache_eligible'
      : 'token_without_session_data'
    : cookieHints.hasSessionData
      ? 'session_data_without_token'
      : 'no_session_cookie'

  return {
    event: 'auth_session_observation',
    phase: options.phase,
    routeGroup: authRouteGroup(url.pathname),
    sampleRate: AUTH_OBSERVATION_SAMPLE_RATE,
    hasSessionToken: cookieHints.hasSessionToken,
    hasSessionData: cookieHints.hasSessionData,
    hasBearer,
    cookieUserResolved: options.cookieUserResolved,
    bearerChecked: Boolean(options.bearerChecked),
    bearerResolved: Boolean(options.bearerResolved),
    cookieCacheState,
  }
}

export function authRouteGroup(pathname: string) {
  if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
    return 'auth'
  }
  if (pathname === '/api/cli' || pathname.startsWith('/api/cli/')) {
    return 'api_cli'
  }
  if (pathname.startsWith('/api/')) return 'api_cookie'
  if (pathname === '/a' || pathname.startsWith('/a/')) return 'share_page'
  return 'page'
}

function logAuthObservation(
  request: Request,
  options: AuthObservationOptions,
  url: URL,
) {
  if (Math.random() >= AUTH_OBSERVATION_SAMPLE_RATE) return
  console.log(JSON.stringify(authObservationPayload(request, options, url)))
}

function authCookieHints(request: Request) {
  const cookieNames = cookieNameSet(request.headers.get('cookie'))
  return {
    hasSessionToken: AUTH_SESSION_TOKEN_COOKIE_NAMES.some((name) =>
      cookieNames.has(name),
    ),
    hasSessionData: AUTH_SESSION_DATA_COOKIE_NAMES.some((name) =>
      cookieNames.has(name),
    ),
  }
}

function cookieNameSet(cookieHeader: string | null) {
  const names = new Set<string>()
  if (!cookieHeader) return names
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=')
    const name = (index === -1 ? part : part.slice(0, index)).trim()
    if (name) names.add(name)
  }
  return names
}

function hasBearerAuth(request: Request) {
  return Boolean(readBearerSessionToken(request))
}
