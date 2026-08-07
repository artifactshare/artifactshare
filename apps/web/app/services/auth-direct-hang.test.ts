import { beforeEach, describe, expect, test, vi } from 'vitest'

const authMocks = vi.hoisted(() => {
  const authQueue: unknown[] = []
  return {
    authQueue,
    betterAuth: vi.fn(() => {
      const auth = authQueue.shift()
      if (!auth) throw new Error('missing auth mock')
      return auth
    }),
    oauthProviderAuthServerMetadata: vi.fn(
      (
        auth: {
          api: { getOAuthServerConfig: () => Promise<Response> | Response }
        },
        _options: unknown,
      ) =>
        async (_request: Request) =>
          await auth.api.getOAuthServerConfig(),
    ),
  }
})

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: {},
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'https://artifactshare.test',
  },
}))

vi.mock('better-auth', () => ({
  betterAuth: authMocks.betterAuth,
}))

vi.mock('better-auth/plugins', () => ({
  deviceAuthorization: vi.fn(() => ({})),
  emailOTP: vi.fn(() => ({})),
  jwt: vi.fn(() => ({})),
  lastLoginMethod: vi.fn(() => ({})),
}))

vi.mock('@better-auth/oauth-provider', () => ({
  oauthProvider: vi.fn(() => ({})),
  oauthProviderAuthServerMetadata: authMocks.oauthProviderAuthServerMetadata,
}))

async function loadAuthServer() {
  vi.resetModules()
  return await import('./auth.server')
}

beforeEach(() => {
  authMocks.authQueue.length = 0
  authMocks.betterAuth.mockClear()
  authMocks.oauthProviderAuthServerMetadata.mockClear()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('authHandlerWithHangDetection', () => {
  test('returns the auth handler response when it settles', async () => {
    const expected = new Response('ok', { status: 201 })
    authMocks.authQueue.push({
      handler: () => Promise.resolve(expected),
    })
    const { authHandlerWithHangDetection } = await loadAuthServer()

    await expect(
      authHandlerWithHangDetection(
        new Request('https://artifactshare.test/api/auth/sign-in'),
      ),
    ).resolves.toBe(expected)
    expect(authMocks.betterAuth).toHaveBeenCalledTimes(1)
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('returns 503 without retrying a hung auth handler', async () => {
    vi.useFakeTimers()
    try {
      authMocks.authQueue.push({
        handler: () => new Promise<Response>(() => {}),
      })
      const { authHandlerWithHangDetection } = await loadAuthServer()

      const responsePromise = authHandlerWithHangDetection(
        new Request('https://artifactshare.test/api/auth/sign-in'),
      )
      await vi.advanceTimersByTimeAsync(30_001)

      await expect(responsePromise).resolves.toMatchObject({ status: 503 })
      expect(authMocks.betterAuth).toHaveBeenCalledTimes(1)
      expect(console.warn).toHaveBeenCalledWith('artifactshare_auth_hang', {
        route: 'auth.handler',
        recovered: false,
      })
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })
})

describe('oauthAuthServerMetadataHandler', () => {
  test('rebuilds auth once after a metadata hang', async () => {
    vi.useFakeTimers()
    try {
      authMocks.authQueue.push(
        {
          api: { getOAuthServerConfig: () => new Promise<Response>(() => {}) },
        },
        {
          api: {
            getOAuthServerConfig: () =>
              new Response('metadata', { status: 200 }),
          },
        },
      )
      const { oauthAuthServerMetadataHandler } = await loadAuthServer()

      const responsePromise = oauthAuthServerMetadataHandler(
        new Request(
          'https://artifactshare.test/.well-known/oauth-authorization-server',
        ),
      )
      await vi.advanceTimersByTimeAsync(3001)

      const response = await responsePromise
      expect(response.status).toBe(200)
      await expect(response.text()).resolves.toBe('metadata')
      expect(authMocks.betterAuth).toHaveBeenCalledTimes(2)
      expect(console.warn).toHaveBeenCalledWith('artifactshare_auth_hang', {
        route: 'oauth.metadata',
        recovered: true,
      })
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  test('returns 503 when metadata hangs again after rebuild', async () => {
    vi.useFakeTimers()
    try {
      authMocks.authQueue.push(
        {
          api: { getOAuthServerConfig: () => new Promise<Response>(() => {}) },
        },
        {
          api: { getOAuthServerConfig: () => new Promise<Response>(() => {}) },
        },
      )
      const { oauthAuthServerMetadataHandler } = await loadAuthServer()

      const responsePromise = oauthAuthServerMetadataHandler(
        new Request(
          'https://artifactshare.test/.well-known/oauth-authorization-server',
        ),
      )
      await vi.advanceTimersByTimeAsync(3001)
      await vi.advanceTimersByTimeAsync(5001)

      await expect(responsePromise).resolves.toMatchObject({ status: 503 })
      expect(authMocks.betterAuth).toHaveBeenCalledTimes(2)
      expect(console.warn).toHaveBeenCalledWith('artifactshare_auth_hang', {
        route: 'oauth.metadata',
        recovered: false,
      })
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })
})

describe('getLocalJwksWithHangDetection', () => {
  test('rebuilds auth once after a JWKS hang', async () => {
    vi.useFakeTimers()
    try {
      const jwks = { keys: [] }
      authMocks.authQueue.push(
        { api: { getJwks: () => new Promise(() => {}) } },
        { api: { getJwks: () => Promise.resolve(jwks) } },
      )
      const { getLocalJwksWithHangDetection } = await loadAuthServer()

      const jwksPromise = getLocalJwksWithHangDetection()
      await vi.advanceTimersByTimeAsync(3001)

      await expect(jwksPromise).resolves.toBe(jwks)
      expect(authMocks.betterAuth).toHaveBeenCalledTimes(2)
      expect(console.warn).toHaveBeenCalledWith('artifactshare_auth_hang', {
        route: 'jwks',
        recovered: true,
      })
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })

  test('throws when JWKS hangs again after rebuild', async () => {
    vi.useFakeTimers()
    try {
      authMocks.authQueue.push(
        { api: { getJwks: () => new Promise(() => {}) } },
        { api: { getJwks: () => new Promise(() => {}) } },
      )
      const { getLocalJwksWithHangDetection } = await loadAuthServer()

      const jwksPromise = getLocalJwksWithHangDetection()
      const expectation = expect(jwksPromise).rejects.toThrow('auth jwks hang')
      await vi.advanceTimersByTimeAsync(3001)
      await vi.advanceTimersByTimeAsync(5001)

      await expectation
      expect(authMocks.betterAuth).toHaveBeenCalledTimes(2)
      expect(console.warn).toHaveBeenCalledWith('artifactshare_auth_hang', {
        route: 'jwks',
        recovered: false,
      })
    } finally {
      vi.useRealTimers()
      vi.restoreAllMocks()
    }
  })
})
