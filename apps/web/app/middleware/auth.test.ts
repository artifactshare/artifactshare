import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { userContext } from './context'

const getSessionUserMock = vi.hoisted(() => vi.fn())
const getSessionUserFromBearerMock = vi.hoisted(() => vi.fn())
const resolveCliAuthorityBySessionTokenMock = vi.hoisted(() => vi.fn())
const readBearerSessionTokenMock = vi.hoisted(() =>
  vi.fn((request: Request) => {
    const authorization = request.headers.get('authorization')
    if (!authorization?.toLowerCase().startsWith('bearer ')) return null
    const token = authorization.slice(7).trim()
    return token ? token.split('.')[0] : null
  }),
)
const createDbMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/auth.server', () => ({
  getSessionUser: getSessionUserMock,
  getSessionUserFromBearer: getSessionUserFromBearerMock,
  readBearerSessionToken: readBearerSessionTokenMock,
}))

vi.mock('~/services/cli-authority.server', () => ({
  resolveCliAuthorityBySessionToken: resolveCliAuthorityBySessionTokenMock,
}))

vi.mock('~/services/db.server', () => ({
  createDb: createDbMock,
}))

vi.mock('cloudflare:workers', () => ({
  // Hidden constraint: keep the legacy env only to exercise the old implementation's failure;
  // this does not restore it in production/runtime.
  env: { OPERATOR_EMAILS: 'operator@example.com' },
}))

const {
  authObservationPayload,
  authRouteGroup,
  requireUserApiWithBearerMiddleware,
  requireUserMiddleware,
  sessionMiddleware,
} = await import('./auth')

function createContext() {
  const values = new Map<unknown, unknown>()
  return {
    get: (key: unknown) => values.get(key),
    set: (key: unknown, value: unknown) => values.set(key, value),
  }
}

function createArgs(
  request: Request = new Request('https://example.test'),
  context = createContext(),
  url = new URL(request.url),
) {
  return {
    request,
    url,
    pattern: '/',
    params: {},
    context: context as any,
  }
}

describe('sessionMiddleware', () => {
  beforeEach(() => {
    getSessionUserMock.mockReset()
    createDbMock.mockClear()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(Math, 'random').mockReturnValue(1)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('ignores stale operator workspace cookies', async () => {
    const user = {
      id: 'user1',
      email: 'operator@example.com',
      workspaceId: 'home',
    }
    getSessionUserMock.mockResolvedValue(user)
    const request = new Request('https://example.test', {
      headers: { Cookie: '__operator_ws=other-workspace' },
    })
    const context = createContext()
    const next = vi.fn()

    await sessionMiddleware(createArgs(request, context), next)

    expect(context.get(userContext)).toBe(user)
    // This mock is intentionally wired to the legacy DB module: reintroducing
    // the old cookie lookup must make the negative control fail.
    expect(createDbMock).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('requireUserMiddleware', () => {
  test('redirects with the normalized URL instead of raw data request details', () => {
    const request = new Request(
      'https://example.test/projects.data?_routes=routes%2F_protected%2Fprojects&tab=owned',
    )
    const normalizedUrl = new URL('https://example.test/projects?tab=owned')

    try {
      requireUserMiddleware(
        createArgs(request, createContext(), normalizedUrl),
        vi.fn(),
      )
      throw new Error('expected redirect')
    } catch (error) {
      expect(error).toBeInstanceOf(Response)
      expect((error as Response).status).toBe(302)
      expect((error as Response).headers.get('Location')).toBe(
        '/?next=%2Fprojects%3Ftab%3Downed',
      )
    }
  })
})

describe('requireUserApiWithBearerMiddleware', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let randomSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    getSessionUserMock.mockReset()
    getSessionUserFromBearerMock.mockReset()
    resolveCliAuthorityBySessionTokenMock.mockReset()
    resolveCliAuthorityBySessionTokenMock.mockResolvedValue({
      kind: 'unrestricted',
    })
    readBearerSessionTokenMock.mockClear()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('uses the existing cookie session without checking bearer auth', async () => {
    const context = createContext()
    const user = { id: 'user1' }
    context.set(userContext, user)
    const next = vi.fn()

    await requireUserApiWithBearerMiddleware(
      createArgs(undefined, context),
      next,
    )

    expect(getSessionUserFromBearerMock).not.toHaveBeenCalled()
    expect(context.get(userContext)).toBe(user)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('fills context from bearer auth when no cookie session exists', async () => {
    const context = createContext()
    const user = { id: 'user1' }
    getSessionUserFromBearerMock.mockResolvedValue(user)
    const request = new Request('https://example.test', {
      headers: { Authorization: 'Bearer session-token' },
    })
    const next = vi.fn()

    await requireUserApiWithBearerMiddleware(createArgs(request, context), next)

    expect(getSessionUserFromBearerMock).toHaveBeenCalledWith(request)
    expect(context.get(userContext)).toBe(user)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('logs sampled bearer fallback without token values', async () => {
    randomSpy.mockReturnValue(0)
    const context = createContext()
    const user = { id: 'user1' }
    getSessionUserFromBearerMock.mockResolvedValue(user)
    const request = new Request('https://example.test/api/cli/whoami', {
      headers: {
        Authorization: 'Bearer secret-bearer-token',
        cookie: 'better-auth.session_token=secret-cookie-token',
      },
    })

    await requireUserApiWithBearerMiddleware(
      createArgs(request, context),
      vi.fn(),
    )

    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).not.toContain('secret-bearer-token')
    expect(logged).not.toContain('secret-cookie-token')
    expect(JSON.parse(logged)).toMatchObject({
      event: 'auth_session_observation',
      phase: 'bearer_api',
      routeGroup: 'api_cli',
      hasBearer: true,
      hasSessionToken: true,
      hasSessionData: false,
      cookieUserResolved: false,
      bearerChecked: true,
      bearerResolved: true,
      cookieCacheState: 'token_without_session_data',
    })
  })

  test('rejects when neither cookie nor bearer auth resolve a user', async () => {
    const context = createContext()
    getSessionUserFromBearerMock.mockResolvedValue(null)

    await expect(
      requireUserApiWithBearerMiddleware(
        createArgs(undefined, context),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ status: 401 })
  })
})

describe('sessionMiddleware auth observation', () => {
  let logSpy: ReturnType<typeof vi.spyOn>
  let randomSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    getSessionUserMock.mockReset()
    getSessionUserFromBearerMock.mockReset()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test('logs sampled cookie cache eligibility without cookie values', async () => {
    randomSpy.mockReturnValue(0)
    const user = { id: 'user1' }
    getSessionUserMock.mockResolvedValue(user)
    const context = createContext()
    const request = new Request('https://example.test/a/shareable-id', {
      headers: {
        cookie: [
          'better-auth.session_token=secret-token',
          'better-auth.session_data=secret-session-data',
        ].join('; '),
      },
    })
    const next = vi.fn()

    await sessionMiddleware(createArgs(request, context), next)

    expect(context.get(userContext)).toBe(user)
    expect(next).toHaveBeenCalledTimes(1)
    expect(logSpy).toHaveBeenCalledTimes(1)
    const logged = logSpy.mock.calls[0][0] as string
    expect(logged).not.toContain('secret-token')
    expect(logged).not.toContain('secret-session-data')
    expect(JSON.parse(logged)).toMatchObject({
      event: 'auth_session_observation',
      phase: 'session',
      routeGroup: 'share_page',
      hasBearer: false,
      hasSessionToken: true,
      hasSessionData: true,
      cookieUserResolved: true,
      bearerChecked: false,
      bearerResolved: false,
      cookieCacheState: 'cookie_cache_eligible',
    })
  })
})

describe('authObservationPayload', () => {
  test('uses only low-cardinality route groups and credential booleans', () => {
    const request = new Request('https://example.test/api/projects/project-1', {
      headers: {
        Authorization: 'Bearer bearer-token',
        cookie:
          '__Secure-better-auth.session_token=session-token; __Secure-better-auth.session_data=session-data',
      },
    })

    expect(
      authObservationPayload(request, {
        bearerChecked: false,
        bearerResolved: false,
        cookieUserResolved: true,
        phase: 'session',
      }),
    ).toMatchObject({
      routeGroup: 'api_cookie',
      hasBearer: true,
      hasSessionToken: true,
      hasSessionData: true,
      cookieCacheState: 'cookie_cache_eligible',
    })
  })

  test('classifies pathnames without retaining path parameters', () => {
    expect(authRouteGroup('/api/auth/sign-in')).toBe('auth')
    expect(authRouteGroup('/api/cli/artifacts/artifact-1')).toBe('api_cli')
    expect(authRouteGroup('/api/shareables/shareable-1')).toBe('api_cookie')
    expect(authRouteGroup('/a/shareable-1')).toBe('share_page')
    expect(authRouteGroup('/projects/project-1')).toBe('page')
  })
})
