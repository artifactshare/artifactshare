import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  env: {
    APP_ENV: 'development',
    BETTER_AUTH_URL: 'https://artifactshare.test',
    MCP_DEV_TOKEN: 'dev-token',
    DB: {},
  } as Record<string, unknown>,
  verifyJwsAccessToken: vi.fn(),
  getLocalJwksWithHangDetection: vi.fn(),
  evaluateFlagshipFlag: vi.fn(),
  createDb: vi.fn(),
  readUser: vi.fn(),
  readSession: vi.fn(),
  sessionWhere: vi.fn(),
  destroy: vi.fn(),
  createMcpServer: vi.fn(),
  serverConnect: vi.fn(),
  transportConstructor: vi.fn(),
  transportHandleRequest: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({ env: mocks.env }))

vi.mock('better-auth/oauth2', () => ({
  verifyJwsAccessToken: mocks.verifyJwsAccessToken,
}))

vi.mock('~/lib/flagship-fallback.server', () => ({
  evaluateFlagshipFlag: mocks.evaluateFlagshipFlag,
}))

vi.mock('~/services/auth.server', () => ({
  getLocalJwksWithHangDetection: mocks.getLocalJwksWithHangDetection,
}))

vi.mock('~/services/db.server', () => ({ createDb: mocks.createDb }))

vi.mock('./server.server', () => ({
  createMcpServer: mocks.createMcpServer,
}))

vi.mock(
  '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js',
  () => ({
    WebStandardStreamableHTTPServerTransport: class {
      constructor(options: unknown) {
        mocks.transportConstructor(options)
      }

      handleRequest(request: Request) {
        return mocks.transportHandleRequest(request)
      }
    },
  }),
)

import { handleMcpRequest } from './transport.server'

const executionContext = {
  waitUntil: vi.fn(),
} as unknown as ExecutionContext

function mcpRequest(token = 'oauth-token') {
  return new Request('https://artifactshare.test/mcp', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
}

beforeEach(() => {
  mocks.env.APP_ENV = 'development'
  mocks.env.BETTER_AUTH_URL = 'https://artifactshare.test'
  mocks.env.MCP_DEV_TOKEN = 'dev-token'
  delete mocks.env.FLAGS
  delete mocks.env.DEV_FLAGS

  mocks.verifyJwsAccessToken.mockReset()
  mocks.getLocalJwksWithHangDetection.mockReset()
  mocks.evaluateFlagshipFlag.mockReset()
  mocks.createDb.mockReset()
  mocks.createMcpServer.mockReset()
  mocks.serverConnect.mockReset()
  mocks.transportConstructor.mockReset()
  mocks.transportHandleRequest.mockReset()

  mocks.verifyJwsAccessToken.mockResolvedValue({
    sub: 'verified-user',
    azp: 'client-1',
    scope: 'openid profile',
  })
  mocks.evaluateFlagshipFlag.mockResolvedValue({
    kind: 'evaluated',
    enabled: false,
  })
  mocks.serverConnect.mockResolvedValue(undefined)
  mocks.createMcpServer.mockReturnValue({ connect: mocks.serverConnect })
  mocks.readUser.mockReset().mockResolvedValue({ oauth_token_version: 0 })
  mocks.readSession.mockReset()
  mocks.sessionWhere.mockReset().mockReturnValue({
    executeTakeFirst: mocks.readSession,
  })
  mocks.destroy.mockReset().mockResolvedValue(undefined)
  mocks.createDb.mockImplementation(() => ({
    destroy: mocks.destroy,
    selectFrom: (table: string) => ({
      select: () => ({
        where:
          table === 'sessions'
            ? mocks.sessionWhere
            : () => ({ executeTakeFirst: mocks.readUser }),
      }),
    }),
  }))
  mocks.transportHandleRequest.mockResolvedValue(
    new Response('handled', { status: 200 }),
  )
})

describe('handleMcpRequest method guard', () => {
  test.each(['GET', 'DELETE', 'OPTIONS', 'HEAD', 'PUT'])(
    'rejects %s before auth and transport setup',
    async (method) => {
      const response = await handleMcpRequest(
        new Request('https://artifactshare.test/mcp', {
          method,
          headers: {
            accept: 'text/event-stream',
            authorization: 'Bearer dev-token',
          },
        }),
        executionContext,
      )

      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('POST')
      expect(mocks.verifyJwsAccessToken).not.toHaveBeenCalled()
      expect(mocks.getLocalJwksWithHangDetection).not.toHaveBeenCalled()
      expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
      expect(mocks.createDb).not.toHaveBeenCalled()
    },
  )

  test('keeps POST on the existing authentication path', async () => {
    const response = await handleMcpRequest(
      new Request('https://artifactshare.test/mcp', { method: 'POST' }),
      executionContext,
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'https://artifactshare.test/.well-known/oauth-protected-resource/mcp',
    )
  })
})

describe('handleMcpRequest product scope enforcement', () => {
  test.each([
    { name: 'legacy-only', scope: 'openid profile email offline_access' },
    { name: 'missing', scope: undefined },
    { name: 'empty', scope: '' },
    { name: 'non-string', scope: ['artifactshare:access'] },
    { name: 'prefixed lookalike', scope: 'openid xartifactshare:access' },
    { name: 'suffixed lookalike', scope: 'artifactshare:access-more openid' },
  ])('returns 403 before MCP handling for $name scopes', async ({ scope }) => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: 'verified-user',
      azp: 'client-1',
      scope,
    })
    const response = await handleMcpRequest(mcpRequest(), executionContext)

    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toBe('Forbidden')
    expect(response.headers.get('WWW-Authenticate')).toBe(
      'Bearer error="insufficient_scope", scope="artifactshare:access", resource_metadata="https://artifactshare.test/.well-known/oauth-protected-resource/mcp"',
    )
    expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
    expect(mocks.createDb).not.toHaveBeenCalled()
    expect(mocks.createMcpServer).not.toHaveBeenCalled()
    expect(mocks.transportConstructor).not.toHaveBeenCalled()
    expect(mocks.transportHandleRequest).not.toHaveBeenCalled()
  })

  test('allows an exact product scope and preserves complete identity and scopes', async () => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: ' verified-user ',
      azp: 'client-1',
      scope: 'openid artifactshare:access offline_access',
    })

    const response = await handleMcpRequest(mcpRequest(), executionContext)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('handled')
    expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
    expect(mocks.createMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          userId: ' verified-user ',
          clientId: 'client-1',
          scopes: ['openid', 'artifactshare:access', 'offline_access'],
          mode: 'oauth',
        },
      }),
    )
  })

  test.each([
    {
      name: 'missing FLAGS',
      environment: {},
      flagResult: {
        kind: 'missing-binding',
        production: false,
        enabled: false,
      },
    },
    {
      name: 'default off',
      environment: { FLAGS: { getBooleanValue: vi.fn() } },
      flagResult: { kind: 'evaluated', enabled: false },
    },
    {
      name: 'evaluation failure',
      environment: { FLAGS: { getBooleanValue: vi.fn() } },
      flagResult: {
        kind: 'evaluation-error',
        error: new Error('flag unavailable'),
      },
    },
  ])(
    '$name cannot relax missing product scope authorization',
    async ({ environment, flagResult }) => {
      Object.assign(mocks.env, environment)
      mocks.verifyJwsAccessToken.mockResolvedValue({
        sub: 'verified-user',
        azp: 'client-1',
        scope: 'openid profile',
      })
      mocks.evaluateFlagshipFlag.mockResolvedValue(flagResult)

      const response = await handleMcpRequest(mcpRequest(), executionContext)

      expect(response.status).toBe(403)
      expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
      expect(mocks.createDb).not.toHaveBeenCalled()
      expect(mocks.createMcpServer).not.toHaveBeenCalled()
    },
  )

  test.each([undefined, 42, '', '  \t'])(
    'rejects invalid subject %s',
    async (sub) => {
      mocks.verifyJwsAccessToken.mockResolvedValue({
        sub,
        azp: 'client-1',
        scope: 'artifactshare:access',
      })
      expect(
        (await handleMcpRequest(mcpRequest(), executionContext)).status,
      ).toBe(401)
      expect(mocks.createMcpServer).not.toHaveBeenCalled()
      expect(mocks.destroy).toHaveBeenCalledOnce()
    },
  )

  test.each([null, '0', -1, 0.5, Number.MAX_SAFE_INTEGER + 1, {}, 1])(
    'rejects malformed or stale version %s',
    async (oauth_token_version) => {
      mocks.verifyJwsAccessToken.mockResolvedValue({
        sub: 'u1',
        azp: 'client-1',
        scope: 'artifactshare:access',
        oauth_token_version,
      })
      expect(
        (await handleMcpRequest(mcpRequest(), executionContext)).status,
      ).toBe(401)
      expect(mocks.createMcpServer).not.toHaveBeenCalled()
      expect(mocks.destroy).toHaveBeenCalledOnce()
    },
  )

  test.each(['missing', 'failure', 'advanced'])(
    'fails closed for %s user version lookup',
    async (scenario) => {
      mocks.verifyJwsAccessToken.mockResolvedValue({
        sub: 'u1',
        azp: 'client-1',
        scope: 'artifactshare:access',
      })
      if (scenario === 'failure')
        mocks.readUser.mockRejectedValue(new Error('database unavailable'))
      else
        mocks.readUser.mockResolvedValue(
          scenario === 'missing' ? undefined : { oauth_token_version: 1 },
        )
      const response = await handleMcpRequest(mcpRequest(), executionContext)
      expect(response.status).toBe(scenario === 'failure' ? 503 : 401)
      expect(response.headers.has('WWW-Authenticate')).toBe(
        scenario !== 'failure',
      )
      expect(mocks.createMcpServer).not.toHaveBeenCalled()
      expect(mocks.destroy).toHaveBeenCalledOnce()
    },
  )

  test('accepts a fresh version without a session claim and shares the connection', async () => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: 'u1',
      azp: 'client-1',
      scope: 'artifactshare:access',
      oauth_token_version: 1,
    })
    mocks.readUser.mockResolvedValue({ oauth_token_version: 1 })
    expect(
      (await handleMcpRequest(mcpRequest(), executionContext)).status,
    ).toBe(200)
    expect(mocks.createDb).toHaveBeenCalledOnce()
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  test.each([
    { name: 'missing', session: undefined, status: 401 },
    { name: 'another user', session: { user_id: 'other-user' }, status: 401 },
    {
      name: 'expired but existing',
      session: { user_id: 'u1', expires_at: '2000-01-01T00:00:00.000Z' },
      status: 200,
    },
  ])('checks a $name session binding', async ({ session, status }) => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: 'u1',
      azp: 'client-1',
      scope: 'artifactshare:access',
      sid: 'session-1',
    })
    mocks.readSession.mockResolvedValue(session)

    expect(
      (await handleMcpRequest(mcpRequest(), executionContext)).status,
    ).toBe(status)
    expect(mocks.sessionWhere).toHaveBeenCalledExactlyOnceWith(
      'id',
      '=',
      'session-1',
    )
    expect(mocks.readSession).toHaveBeenCalledOnce()
    expect(mocks.createMcpServer).toHaveBeenCalledTimes(status === 200 ? 1 : 0)
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  test.each([undefined, null])('accepts an unbound sid %s', async (sid) => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: 'u1',
      azp: 'client-1',
      scope: 'artifactshare:access',
      sid,
    })
    expect(
      (await handleMcpRequest(mcpRequest(), executionContext)).status,
    ).toBe(200)
    expect(mocks.readSession).not.toHaveBeenCalled()
  })

  test.each(['', ' ', 42, {}])('rejects malformed sid %s', async (sid) => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: 'u1',
      azp: 'client-1',
      scope: 'artifactshare:access',
      sid,
    })
    expect(
      (await handleMcpRequest(mcpRequest(), executionContext)).status,
    ).toBe(401)
    expect(mocks.createMcpServer).not.toHaveBeenCalled()
  })

  test('fails closed when the session lookup fails', async () => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: 'u1',
      azp: 'client-1',
      scope: 'artifactshare:access',
      sid: 'session-1',
    })
    mocks.readSession.mockRejectedValue(new Error('database unavailable'))
    expect(
      (await handleMcpRequest(mcpRequest(), executionContext)).status,
    ).toBe(503)
    expect(mocks.createMcpServer).not.toHaveBeenCalled()
    expect(mocks.destroy).toHaveBeenCalledOnce()
  })

  test('invalid token returns 401 without Flagship evaluation or MCP handling', async () => {
    mocks.verifyJwsAccessToken.mockRejectedValue(new Error('invalid token'))

    const response = await handleMcpRequest(mcpRequest(), executionContext)

    expect(response.status).toBe(401)
    expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
    expect(mocks.createDb).not.toHaveBeenCalled()
  })

  test('missing client identity returns 401 without Flagship evaluation', async () => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: 'verified-user',
      scope: 'artifactshare:access',
    })

    const response = await handleMcpRequest(mcpRequest(), executionContext)

    expect(response.status).toBe(401)
    expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
    expect(mocks.createDb).not.toHaveBeenCalled()
  })

  test('production does not allow the fixed development token to bypass OAuth', async () => {
    mocks.env.APP_ENV = 'production'
    mocks.verifyJwsAccessToken.mockRejectedValue(new Error('invalid token'))

    const response = await handleMcpRequest(
      mcpRequest('dev-token'),
      executionContext,
    )

    expect(response.status).toBe(401)
    expect(mocks.verifyJwsAccessToken).toHaveBeenCalledWith(
      'dev-token',
      expect.any(Object),
    )
    expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
    expect(mocks.createDb).not.toHaveBeenCalled()
  })

  test('non-production fixed development token keeps bypassing OAuth and Flagship', async () => {
    const response = await handleMcpRequest(
      mcpRequest('dev-token'),
      executionContext,
    )

    expect(response.status).toBe(200)
    expect(mocks.verifyJwsAccessToken).not.toHaveBeenCalled()
    expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
    expect(mocks.createMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: {
          userId: 'dev-user',
          clientId: null,
          scopes: ['openid', 'artifactshare:access'],
          mode: 'dev',
        },
      }),
    )
  })
})
