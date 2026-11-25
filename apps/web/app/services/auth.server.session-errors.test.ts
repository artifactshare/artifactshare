import type { MockInstance } from 'vitest'
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

let warn: MockInstance<typeof console.warn>

beforeEach(() => {
  vi.resetModules()
  mocks.getSession.mockReset()
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

/**
 * The one logged entry, with its marker dropped: the marker names the event for
 * whoever reads the logs, while the fields are what the entry may disclose.
 */
function loggedSessionError() {
  expect(warn.mock.calls).toHaveLength(1)
  const [marker, fields] = warn.mock.calls[0]!
  expect(typeof marker).toBe('string')
  for (const secret of ['test-secret', 'user@example.com', 'u1'])
    expect(JSON.stringify(fields)).not.toContain(secret)
  return fields
}

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
  expect(loggedSessionError()).toEqual({
    errorName: 'SessionLookupError',
    errorMessage: 'Session lookup failed',
  })
})

test('uses fixed fallback fields for a non-Error rejection', async () => {
  mocks.getSession.mockRejectedValue({ token: 'test-secret', user: 'u1' })
  await expect(readSession()).resolves.toBeNull()
  expect(loggedSessionError()).toEqual({
    errorName: 'UnknownError',
    errorMessage: 'Unexpected session lookup failure',
  })
})

test('does not warn for an unauthorized APIError', async () => {
  const { APIError } = await import('better-auth/api')
  mocks.getSession.mockRejectedValue(
    new APIError('UNAUTHORIZED', {
      message: 'Failed to get session',
      code: 'FAILED_TO_GET_SESSION',
    }),
  )
  await expect(readSession()).resolves.toBeNull()
  expect(console.warn).not.toHaveBeenCalled()
})

test.each([true, false])(
  'logs an unexpected APIError with status and optional code (code present: %s)',
  async (includeCode) => {
    const { APIError } = await import('better-auth/api')
    mocks.getSession.mockRejectedValue(
      new APIError(
        'INTERNAL_SERVER_ERROR',
        {
          message: 'Failed to get session',
          ...(includeCode ? { code: 'FAILED_TO_GET_SESSION' } : {}),
          cause: { token: 'test-secret' },
          user: { id: 'u1', email: 'user@example.com' },
        },
        { 'set-cookie': 'better-auth.session_token=test-secret' },
      ),
    )
    await expect(readSession()).resolves.toBeNull()
    expect(loggedSessionError()).toEqual({
      errorName: 'APIError',
      errorMessage: 'Failed to get session',
      status: 'INTERNAL_SERVER_ERROR',
      ...(includeCode ? { code: 'FAILED_TO_GET_SESSION' } : {}),
    })
  },
)

test('does not warn for an ordinary unauthenticated session', async () => {
  mocks.getSession.mockResolvedValue(null)
  await expect(readSession()).resolves.toBeNull()
  expect(console.warn).not.toHaveBeenCalled()
})
