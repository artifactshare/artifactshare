import { settingsSubmissionMiddleware } from '~/lib/settings-confirmation'
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
import {
  resolveCliAuthorityBySessionToken,
  type CliAuthority,
} from '~/services/cli-authority.server'
import type { SessionUser } from '~/lib/user'
import { isApiToken } from '~/services/api-tokens.server'
import {
  allowsCliOperation,
  cliScopeDeniedResponse,
} from '~/lib/cli-agent-operations'
import { bridgeErrorResponse } from '~/lib/bridge-api.server'
import { authSourceContext, cliAuthorityContext, userContext } from './context'

const AUTH_OBSERVATION_SAMPLE_RATE = 0.05

type AuthObservationOptions = {
  bearerChecked?: boolean
  bearerResolved?: boolean
  cookieUserResolved: boolean
  phase: 'session' | 'bearer_api'
}

export const sessionMiddleware = settingsSubmissionMiddleware(
  async ({ request, context, url }, next) => {
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
  },
)

export const requireUserMiddleware = settingsSubmissionMiddleware(
  ({ context, url }) => {
    if (context.get(userContext)) return
    throw redirect(`/?next=${encodeURIComponent(url.pathname + url.search)}`)
  },
)

export const requireUserApiMiddleware: MiddlewareFunction = ({ context }) => {
  if (context.get(userContext)) return
  throw new Response('Unauthorized', { status: 401 })
}

// `absent` is the only state that may keep a cookie identity. Every other
// state clears it, so a failed bearer credential can never fall through to
// the browser session.
type BearerCredential =
  | { kind: 'absent' }
  | { kind: 'unusable' }
  | { kind: 'rejected' }
  | { kind: 'accepted'; user: SessionUser; authority: CliAuthority }

async function readBearerCredential(
  request: Request,
): Promise<BearerCredential> {
  const token = readBearerSessionToken(request)
  if (!token)
    return hasBearerScheme(request) ? { kind: 'unusable' } : { kind: 'absent' }
  const user = await getSessionUserFromBearer(request)
  if (!user) return { kind: 'rejected' }
  if (isApiToken(token)) {
    if (user.kind === 'bot') return { kind: 'rejected' }
    return { kind: 'accepted', user, authority: { kind: 'unrestricted' } }
  }
  const resolution = await resolveCliAuthorityBySessionToken(token)
  if (!resolution || resolution === 'denied') return { kind: 'rejected' }
  return { kind: 'accepted', user, authority: resolution }
}

export const requireUserApiWithBearerMiddleware: MiddlewareFunction = async (
  { request, context, url },
  next,
) => {
  const bearer = await readBearerCredential(request)
  if (bearer.kind === 'accepted') {
    context.set(userContext, bearer.user)
    context.set(authSourceContext, 'bearer')
    context.set(cliAuthorityContext, bearer.authority)
  } else if (bearer.kind === 'absent') {
    context.set(authSourceContext, context.get(userContext) ? 'cookie' : null)
  } else {
    context.set(userContext, null)
    context.set(authSourceContext, null)
    context.set(cliAuthorityContext, null)
  }
  if (bearer.kind === 'accepted' || bearer.kind === 'rejected') {
    logAuthObservation(
      request,
      {
        bearerChecked: true,
        bearerResolved: bearer.kind === 'accepted',
        cookieUserResolved: false,
        phase: 'bearer_api',
      },
      url,
    )
  }
  if (
    bearer.kind === 'accepted' &&
    !allowsCliOperation(bearer.authority, request.method, url.pathname)
  )
    throw cliScopeDeniedResponse()
  if (context.get(userContext)) return next()
  throw new Response('Unauthorized', { status: 401 })
}

export const requireBridgeBearerMiddleware: MiddlewareFunction = async (
  args,
  next,
) => {
  let enteredRoute = false
  try {
    return await requireUserApiWithBearerMiddleware(args, () => {
      enteredRoute = true
      return next()
    })
  } catch (error) {
    if (!enteredRoute) {
      if (error instanceof Response && error.status === 401) {
        return bridgeErrorResponse(
          'unauthorized',
          'The bridge credential is invalid or expired.',
          401,
        )
      }
      if (error instanceof Response && error.status === 403) {
        return bridgeErrorResponse(
          'unsupported-authority',
          'This credential is not a bridge authority.',
          403,
        )
      }
      console.error('bridge_auth_failed', error)
      return bridgeErrorResponse(
        'internal-error',
        'The bridge authentication check failed.',
        500,
        { retryable: true, retryAfterMs: 1_000 },
      )
    }
    throw error
  }
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

function hasBearerScheme(request: Request) {
  return /^bearer(?:\s|$)/i.test(request.headers.get('authorization') ?? '')
}
