import type { CliAuthority } from '~/services/cli-authority.server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { authSourceContext, cliAuthorityContext, userContext } from './context'

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
  requireBridgeBearerMiddleware,
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

  test.each([
    '/api/cli/artifacts',
    '/api/cli/doctor',
    '/api/cli/resolve',
    '/api/bridge/v1/health',
  ])(
    'does not invoke the handler for unknown authority on %s',
    async (path) => {
      const context = createContext()
      getSessionUserFromBearerMock.mockResolvedValue({ id: 'u1' })
      resolveCliAuthorityBySessionTokenMock.mockResolvedValue({
        kind: 'unknown',
      } as unknown as CliAuthority)
      const next = vi.fn()
      const request = new Request(`https://example.test${path}`, {
        headers: { Authorization: 'Bearer ass_test' },
      })
      const response = await Promise.resolve(
        requireUserApiWithBearerMiddleware(createArgs(request, context), next),
      ).catch((error: unknown) => error)
      if (!(response instanceof Response))
        throw new Error('Expected scope denial')
      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'scope-denied' },
      })
      expect(next).not.toHaveBeenCalled()
    },
  )

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

  test('rejects an invalid bearer instead of falling back to a cookie', async () => {
    const context = createContext()
    context.set(userContext, { id: 'cookie-user' })
    getSessionUserFromBearerMock.mockResolvedValue(null)
    const request = new Request('https://example.test/api/cli/artifacts', {
      headers: { Authorization: 'Bearer invalid-session-token' },
    })

    await expect(
      requireUserApiWithBearerMiddleware(createArgs(request, context), vi.fn()),
    ).rejects.toMatchObject({ status: 401 })
    expect(context.get(userContext)).toBeNull()
  })

  test('rejects a malformed bearer scheme instead of falling back to a cookie', async () => {
    const context = createContext()
    context.set(userContext, { id: 'cookie-user' })
    const request = new Request('https://example.test/api/cli/artifacts', {
      headers: { Authorization: 'Bearer .suffix' },
    })

    await expect(
      requireUserApiWithBearerMiddleware(createArgs(request, context), vi.fn()),
    ).rejects.toMatchObject({ status: 401 })
    expect(getSessionUserFromBearerMock).not.toHaveBeenCalled()
    expect(context.get(userContext)).toBeNull()
  })

  test('rejects an empty bearer credential instead of falling back to a cookie', async () => {
    const context = createContext()
    context.set(userContext, { id: 'cookie-user' })
    const request = new Request('https://example.test/api/cli/artifacts', {
      headers: { Authorization: 'Bearer' },
    })

    await expect(
      requireUserApiWithBearerMiddleware(createArgs(request, context), vi.fn()),
    ).rejects.toMatchObject({ status: 401 })
    expect(context.get(userContext)).toBeNull()
  })

  test('uses bearer identity in preference to a different cookie user', async () => {
    const context = createContext()
    context.set(userContext, { id: 'cookie-user' })
    const bearerUser = { id: 'bearer-user' }
    getSessionUserFromBearerMock.mockResolvedValue(bearerUser)
    const request = new Request('https://example.test/api/cli/artifacts', {
      headers: { Authorization: 'Bearer session-token' },
    })
    const next = vi.fn()

    await requireUserApiWithBearerMiddleware(createArgs(request, context), next)

    expect(context.get(userContext)).toBe(bearerUser)
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

  test('keeps API token bearer authentication unrestricted', async () => {
    const context = createContext()
    const user = { id: 'user1' }
    getSessionUserFromBearerMock.mockResolvedValue(user)
    const request = new Request('https://example.test/api/cli/artifacts', {
      headers: { Authorization: 'Bearer ast_api_token' },
    })
    const next = vi.fn()

    await requireUserApiWithBearerMiddleware(createArgs(request, context), next)

    expect(resolveCliAuthorityBySessionTokenMock).not.toHaveBeenCalled()
    expect(context.get(userContext)).toBe(user)
    expect(next).toHaveBeenCalledTimes(1)
  })

  test('logs sampled bearer auth before returning scope denied', async () => {
    randomSpy.mockReturnValue(0)
    const context = createContext()
    getSessionUserFromBearerMock.mockResolvedValue({ id: 'agent-user' })
    resolveCliAuthorityBySessionTokenMock.mockResolvedValue({
      kind: 'agent',
      familyId: 'family-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      projectNameSnapshot: 'Project',
      agentProfileId: 'agent-1',
    })
    const request = new Request('https://example.test/api/cli/projects/p1', {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token' },
    })

    await expect(
      requireUserApiWithBearerMiddleware(createArgs(request, context), vi.fn()),
    ).rejects.toMatchObject({ status: 403 })
    expect(logSpy).toHaveBeenCalledTimes(1)
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

  test('returns bridge JSON for an invalid bridge bearer', async () => {
    getSessionUserFromBearerMock.mockResolvedValue(null)
    const request = new Request('https://example.test/api/bridge/v1/health', {
      headers: { Authorization: 'Bearer invalid-session-token' },
    })

    const response = (await requireBridgeBearerMiddleware(
      createArgs(request),
      vi.fn(),
    )) as Response

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      ok: false,
      error: { code: 'unauthorized', retryable: false },
    })
  })

  test('returns bridge JSON when a non-bridge authority is scope denied', async () => {
    getSessionUserFromBearerMock.mockResolvedValue({ id: 'agent-user' })
    resolveCliAuthorityBySessionTokenMock.mockResolvedValue({
      kind: 'agent',
      familyId: 'family-1',
      workspaceId: 'workspace-1',
      projectId: 'project-1',
      projectNameSnapshot: 'Project',
      agentProfileId: 'agent-1',
    })
    const request = new Request('https://example.test/api/bridge/v1/requests', {
      method: 'POST',
      headers: { Authorization: 'Bearer session-token' },
    })

    const response = (await requireBridgeBearerMiddleware(
      createArgs(request),
      vi.fn(),
    )) as Response

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      ok: false,
      error: { code: 'unsupported-authority', retryable: false },
    })
  })

  test('returns retryable bridge JSON when bearer resolution throws', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    getSessionUserFromBearerMock.mockRejectedValue(new Error('D1 unavailable'))
    const request = new Request('https://example.test/api/bridge/v1/health', {
      headers: { Authorization: 'Bearer session-token' },
    })

    const response = (await requireBridgeBearerMiddleware(
      createArgs(request),
      vi.fn(),
    )) as Response

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toMatchObject({
      schema_version: 1,
      ok: false,
      error: {
        code: 'internal-error',
        retryable: true,
        retry_after_ms: 1_000,
      },
    })
    expect(consoleError).toHaveBeenCalled()
  })
})

const cookieUser = { id: 'cookie-user', kind: 'human' }
const bearerHuman = { id: 'bearer-user', kind: 'human' }
const bearerBot = { id: 'bearer-bot', kind: 'bot' }
const unrestrictedAuthority = { kind: 'unrestricted' }
const agentAuthority = {
  kind: 'agent',
  familyId: 'family-1',
  workspaceId: 'workspace-1',
  projectId: 'project-1',
  projectNameSnapshot: 'Project',
  agentProfileId: 'agent-1',
}

type CredentialCase = {
  name: string
  authorization?: string
  cookieUser?: typeof cookieUser
  bearerUser?: unknown
  authorityResolution?: unknown
  method?: string
  path?: string
  entered: boolean
  status?: number
  user: 'cookie' | 'bearer' | null
  authSource: 'cookie' | 'bearer' | null
  authority: 'unrestricted' | 'agent' | null
  bearerChecked: boolean
  bearerResolved: boolean
  logged: boolean
}

// One row per branch of the credential decision. Every row states the whole
// outcome, so a branch that starts leaking a cookie identity or skipping the
// bot denial fails here rather than in a route.
const credentialCases: CredentialCase[] = [
  {
    name: 'no bearer header falls back to the cookie session',
    cookieUser,
    entered: true,
    user: 'cookie',
    authSource: 'cookie',
    authority: null,
    bearerChecked: false,
    bearerResolved: false,
    logged: false,
  },
  {
    name: 'no bearer header and no cookie session is unauthorized',
    entered: false,
    status: 401,
    user: null,
    authSource: null,
    authority: null,
    bearerChecked: false,
    bearerResolved: false,
    logged: false,
  },
  {
    name: 'a malformed bearer scheme never falls back to the cookie',
    authorization: 'Bearer .suffix',
    cookieUser,
    entered: false,
    status: 401,
    user: null,
    authSource: null,
    authority: null,
    bearerChecked: false,
    bearerResolved: false,
    logged: false,
  },
  {
    name: 'an empty bearer credential never falls back to the cookie',
    authorization: 'Bearer',
    cookieUser,
    entered: false,
    status: 401,
    user: null,
    authSource: null,
    authority: null,
    bearerChecked: false,
    bearerResolved: false,
    logged: false,
  },
  {
    name: 'an unresolvable bearer never falls back to the cookie',
    authorization: 'Bearer session-token',
    cookieUser,
    bearerUser: null,
    entered: false,
    status: 401,
    user: null,
    authSource: null,
    authority: null,
    bearerChecked: true,
    bearerResolved: false,
    logged: true,
  },
  {
    name: 'an API token for a bot is denied',
    authorization: 'Bearer ast_api_token',
    cookieUser,
    bearerUser: bearerBot,
    entered: false,
    status: 401,
    user: null,
    authSource: null,
    authority: null,
    bearerChecked: true,
    bearerResolved: false,
    logged: true,
  },
  {
    name: 'an API token for a person is unrestricted',
    authorization: 'Bearer ast_api_token',
    bearerUser: bearerHuman,
    entered: true,
    user: 'bearer',
    authSource: 'bearer',
    authority: 'unrestricted',
    bearerChecked: true,
    bearerResolved: true,
    logged: true,
  },
  {
    name: 'a session token without an authority is unauthorized',
    authorization: 'Bearer session-token',
    cookieUser,
    bearerUser: bearerHuman,
    authorityResolution: null,
    entered: false,
    status: 401,
    user: null,
    authSource: null,
    authority: null,
    bearerChecked: true,
    bearerResolved: false,
    logged: true,
  },
  {
    name: 'a session token whose authority is denied is unauthorized',
    authorization: 'Bearer session-token',
    cookieUser,
    bearerUser: bearerHuman,
    authorityResolution: 'denied',
    entered: false,
    status: 401,
    user: null,
    authSource: null,
    authority: null,
    bearerChecked: true,
    bearerResolved: false,
    logged: true,
  },
  {
    name: 'a session token with an in-scope authority enters the route',
    authorization: 'Bearer session-token',
    cookieUser,
    bearerUser: bearerHuman,
    authorityResolution: unrestrictedAuthority,
    entered: true,
    user: 'bearer',
    authSource: 'bearer',
    authority: 'unrestricted',
    bearerChecked: true,
    bearerResolved: true,
    logged: true,
  },
  {
    name: 'a session token with an out-of-scope authority is scope denied',
    authorization: 'Bearer session-token',
    bearerUser: bearerHuman,
    authorityResolution: agentAuthority,
    method: 'POST',
    path: '/api/cli/projects/p1',
    entered: false,
    status: 403,
    user: 'bearer',
    authSource: 'bearer',
    authority: 'agent',
    bearerChecked: true,
    bearerResolved: true,
    logged: true,
  },
]

describe('requireUserApiWithBearerMiddleware credential branches', () => {
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    getSessionUserMock.mockReset()
    getSessionUserFromBearerMock.mockReset()
    resolveCliAuthorityBySessionTokenMock.mockReset()
    readBearerSessionTokenMock.mockClear()
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  test.each(credentialCases)('$name', async (branch) => {
    const context = createContext()
    if (branch.cookieUser) context.set(userContext, branch.cookieUser)
    getSessionUserFromBearerMock.mockResolvedValue(branch.bearerUser ?? null)
    resolveCliAuthorityBySessionTokenMock.mockResolvedValue(
      branch.authorityResolution ?? null,
    )
    const request = new Request(
      `https://example.test${branch.path ?? '/api/cli/artifacts'}`,
      {
        method: branch.method ?? 'GET',
        ...(branch.authorization
          ? { headers: { Authorization: branch.authorization } }
          : {}),
      },
    )
    const next = vi.fn()

    const thrown = await Promise.resolve(
      requireUserApiWithBearerMiddleware(createArgs(request, context), next),
    ).catch((error: unknown) => error)

    expect(next).toHaveBeenCalledTimes(branch.entered ? 1 : 0)
    if (branch.status === undefined) {
      expect(thrown).not.toBeInstanceOf(Response)
    } else {
      expect(thrown).toBeInstanceOf(Response)
      expect((thrown as Response).status).toBe(branch.status)
    }
    const expectedUser =
      branch.user === 'cookie'
        ? branch.cookieUser
        : branch.user === 'bearer'
          ? branch.bearerUser
          : null
    expect(context.get(userContext) ?? null).toEqual(expectedUser)
    expect(context.get(authSourceContext) ?? null).toBe(branch.authSource)
    const expectedAuthority =
      branch.authority === 'unrestricted'
        ? unrestrictedAuthority
        : branch.authority === 'agent'
          ? agentAuthority
          : null
    expect(context.get(cliAuthorityContext) ?? null).toEqual(expectedAuthority)
    expect(getSessionUserFromBearerMock).toHaveBeenCalledTimes(
      branch.bearerChecked ? 1 : 0,
    )
    expect(logSpy).toHaveBeenCalledTimes(branch.logged ? 1 : 0)
    if (branch.logged) {
      expect(JSON.parse(logSpy.mock.calls[0]![0] as string)).toMatchObject({
        phase: 'bearer_api',
        hasBearer: true,
        bearerChecked: branch.bearerChecked,
        bearerResolved: branch.bearerResolved,
        cookieUserResolved: false,
      })
    }
  })

  test('an API token never consults the CLI authority table', async () => {
    const context = createContext()
    getSessionUserFromBearerMock.mockResolvedValue(bearerHuman)
    const request = new Request('https://example.test/api/cli/artifacts', {
      headers: { Authorization: 'Bearer ast_api_token' },
    })

    await requireUserApiWithBearerMiddleware(
      createArgs(request, context),
      vi.fn(),
    )

    expect(resolveCliAuthorityBySessionTokenMock).not.toHaveBeenCalled()
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
