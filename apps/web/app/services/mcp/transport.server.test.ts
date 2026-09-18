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
  mocks.createDb.mockImplementation(() => ({
    destroy: vi.fn().mockResolvedValue(undefined),
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
  ])(
    'returns 403 before MCP handling for $name scopes when ON',
    async ({ scope }) => {
      mocks.verifyJwsAccessToken.mockResolvedValue({
        sub: 'verified-user',
        azp: 'client-1',
        scope,
      })
      mocks.evaluateFlagshipFlag.mockResolvedValue({
        kind: 'evaluated',
        enabled: true,
      })

      const response = await handleMcpRequest(mcpRequest(), executionContext)

      expect(response.status).toBe(403)
      await expect(response.text()).resolves.toBe('Forbidden')
      expect(response.headers.get('WWW-Authenticate')).toBe(
        'Bearer error="insufficient_scope", scope="artifactshare:access", resource_metadata="https://artifactshare.test/.well-known/oauth-protected-resource/mcp"',
      )
      expect(mocks.evaluateFlagshipFlag).toHaveBeenCalledTimes(1)
      expect(mocks.createDb).not.toHaveBeenCalled()
      expect(mocks.createMcpServer).not.toHaveBeenCalled()
      expect(mocks.transportConstructor).not.toHaveBeenCalled()
      expect(mocks.transportHandleRequest).not.toHaveBeenCalled()
    },
  )

  test('allows an exact product scope and preserves complete identity and scopes', async () => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: ' verified-user ',
      azp: 'client-1',
      scope: 'openid artifactshare:access offline_access',
    })
    mocks.evaluateFlagshipFlag.mockResolvedValue({
      kind: 'evaluated',
      enabled: true,
    })

    const response = await handleMcpRequest(mcpRequest(), executionContext)

    expect(response.status).toBe(200)
    await expect(response.text()).resolves.toBe('handled')
    expect(mocks.evaluateFlagshipFlag).toHaveBeenCalledTimes(1)
    expect(mocks.evaluateFlagshipFlag).toHaveBeenCalledWith(mocks.env, {
      flagKey: 'mcp-require-product-scope',
      context: { userId: ' verified-user ' },
    })
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

  test('evaluated false for another user preserves current allowed behavior', async () => {
    mocks.verifyJwsAccessToken.mockResolvedValue({
      sub: 'another-user',
      azp: 'client-1',
      scope: 'openid',
    })

    const response = await handleMcpRequest(mcpRequest(), executionContext)

    expect(response.status).toBe(200)
    expect(mocks.evaluateFlagshipFlag).toHaveBeenCalledWith(mocks.env, {
      flagKey: 'mcp-require-product-scope',
      context: { userId: 'another-user' },
    })
    expect(mocks.evaluateFlagshipFlag).toHaveBeenCalledTimes(1)
  })

  test.each([false, true])(
    'missing binding stays fail-OFF when its fallback is %s',
    async (enabled) => {
      mocks.evaluateFlagshipFlag.mockResolvedValue({
        kind: 'missing-binding',
        production: false,
        enabled,
      })

      const response = await handleMcpRequest(mcpRequest(), executionContext)

      expect(response.status).toBe(200)
      expect(mocks.createDb).toHaveBeenCalledTimes(1)
    },
  )

  test('evaluation error is logged without request identity and stays fail-OFF', async () => {
    const error = new Error('flag unavailable')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    mocks.evaluateFlagshipFlag.mockResolvedValue({
      kind: 'evaluation-error',
      error,
    })

    const response = await handleMcpRequest(mcpRequest(), executionContext)

    expect(response.status).toBe(200)
    expect(consoleError).toHaveBeenCalledWith(
      'mcp_scope_flag_evaluation_failed',
      error,
    )
    expect(consoleError).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })

  test.each([
    { name: 'missing', sub: undefined, expectedUserId: '' },
    { name: 'non-string', sub: 42, expectedUserId: '' },
    { name: 'empty', sub: '', expectedUserId: '' },
    { name: 'whitespace', sub: '  \t', expectedUserId: '  \t' },
  ])(
    'skips evaluation for $name signed subject and preserves current identity',
    async ({ sub, expectedUserId }) => {
      mocks.verifyJwsAccessToken.mockResolvedValue({
        sub,
        azp: 'client-1',
        scope: 'openid profile',
      })

      const response = await handleMcpRequest(mcpRequest(), executionContext)

      expect(response.status).toBe(200)
      expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
      expect(mocks.createMcpServer).toHaveBeenCalledWith(
        expect.objectContaining({
          identity: {
            userId: expectedUserId,
            clientId: 'client-1',
            scopes: ['openid', 'profile'],
            mode: 'oauth',
          },
        }),
      )
    },
  )

  test('invalid token returns 401 without flag evaluation or MCP handling', async () => {
    mocks.verifyJwsAccessToken.mockRejectedValue(new Error('invalid token'))

    const response = await handleMcpRequest(mcpRequest(), executionContext)

    expect(response.status).toBe(401)
    expect(mocks.evaluateFlagshipFlag).not.toHaveBeenCalled()
    expect(mocks.createDb).not.toHaveBeenCalled()
  })

  test('missing client identity returns 401 without flag evaluation', async () => {
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

  test('non-production fixed development token keeps bypassing OAuth and the flag', async () => {
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
          scopes: ['openid'],
          mode: 'dev',
        },
      }),
    )
  })

  test('OFF to ON to OFF requests do not retain enforcement state', async () => {
    mocks.evaluateFlagshipFlag
      .mockResolvedValueOnce({ kind: 'evaluated', enabled: false })
      .mockResolvedValueOnce({ kind: 'evaluated', enabled: true })
      .mockResolvedValueOnce({ kind: 'evaluated', enabled: false })

    const responses = []
    for (let requestIndex = 0; requestIndex < 3; requestIndex += 1) {
      responses.push(await handleMcpRequest(mcpRequest(), executionContext))
    }

    expect(responses.map((response) => response.status)).toEqual([
      200, 403, 200,
    ])
    expect(mocks.evaluateFlagshipFlag).toHaveBeenCalledTimes(3)
    expect(mocks.createDb).toHaveBeenCalledTimes(2)
  })
})
