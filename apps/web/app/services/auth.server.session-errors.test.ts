import { afterEach, beforeEach, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('cloudflare:workers', () => ({
  env: {
    DB: {},
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'https://example.com',
  },
}))
vi.mock('better-auth', () => ({
  betterAuth: vi.fn(() => ({ api: { getSession: mocks.getSession } })),
}))
vi.mock('better-auth/plugins', () => ({
  deviceAuthorization: vi.fn(() => ({})),
  emailOTP: vi.fn(() => ({})),
  jwt: vi.fn(() => ({})),
  lastLoginMethod: vi.fn(() => ({})),
}))
vi.mock('@better-auth/oauth-provider', () => ({
  oauthProvider: vi.fn(() => ({})),
  oauthProviderAuthServerMetadata: vi.fn(),
}))

beforeEach(() => {
  vi.resetModules()
  mocks.getSession.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

async function readSession() {
  const { getBrowserSessionContext } = await import('./auth.server')
  return getBrowserSessionContext(
    new Request('https://example.com', {
      headers: {
        cookie: 'better-auth.session_token=test-secret',
        authorization: 'Bearer test-secret',
      },
    }),
  )
}

test('logs only the event, error name and message once and returns null', async () => {
  const error = Object.assign(new Error('Session lookup failed'), {
    name: 'SessionLookupError',
    cause: { token: 'test-secret' },
    user: { id: 'u1', email: 'user@example.com' },
    headers: { cookie: 'test-secret' },
  })
  mocks.getSession.mockRejectedValue(error)
  await expect(readSession()).resolves.toBeNull()
  expect(console.warn).toHaveBeenCalledExactlyOnceWith(
    'artifactshare_auth_session_error',
    {
      errorName: 'SessionLookupError',
      errorMessage: 'Session lookup failed',
    },
  )
})

test('uses fixed fallback fields for a non-Error rejection', async () => {
  mocks.getSession.mockRejectedValue({ token: 'test-secret', user: 'u1' })
  await expect(readSession()).resolves.toBeNull()
  expect(console.warn).toHaveBeenCalledExactlyOnceWith(
    'artifactshare_auth_session_error',
    {
      errorName: 'UnknownError',
      errorMessage: 'Unexpected session lookup failure',
    },
  )
})

test('does not warn for an ordinary unauthenticated session', async () => {
  mocks.getSession.mockResolvedValue(null)
  await expect(readSession()).resolves.toBeNull()
  expect(console.warn).not.toHaveBeenCalled()
})
