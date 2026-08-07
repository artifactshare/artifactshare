import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const getSessionUserFromBearerMock = vi.hoisted(() => vi.fn())
const readBearerSessionTokenMock = vi.hoisted(() =>
  vi.fn((request: Request) => {
    const authorization = request.headers.get('authorization')
    if (!authorization?.toLowerCase().startsWith('bearer ')) return null
    const token = authorization.slice(7).trim()
    return token ? token.split('.')[0] : null
  }),
)
const withDbMock = vi.hoisted(() => vi.fn())
const issueCliRefreshCredentialMock = vi.hoisted(() => vi.fn())
const isCliRefreshedSessionTokenMock = vi.hoisted(() =>
  vi.fn((token: string) => token.startsWith('ass_')),
)

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))

vi.mock('~/services/auth.server', () => ({
  getSessionUserFromBearer: getSessionUserFromBearerMock,
  readBearerSessionToken: readBearerSessionTokenMock,
}))

vi.mock('~/services/db.server', () => ({
  withDb: withDbMock,
}))

vi.mock('~/services/cli-refresh-credentials.server', () => ({
  isCliRefreshedSessionToken: isCliRefreshedSessionTokenMock,
  issueCliRefreshCredential: issueCliRefreshCredentialMock,
}))

const { action, middleware } =
  await import('./api.cli.auth.refresh-credentials')

describe('/api/cli/auth/refresh-credentials', () => {
  beforeEach(() => {
    getSessionUserFromBearerMock.mockReset()
    readBearerSessionTokenMock.mockClear()
    withDbMock.mockReset()
    issueCliRefreshCredentialMock.mockReset()
    isCliRefreshedSessionTokenMock.mockClear()
  })

  test('requires bearer middleware', () => {
    expect(middleware).toEqual([requireUserApiWithBearerMiddlewareMock])
  })

  test('issues a refresh credential for the authenticated user', async () => {
    getSessionUserFromBearerMock.mockResolvedValue({ id: 'user1' })
    issueCliRefreshCredentialMock.mockResolvedValue({
      refreshToken: 'asr_refresh',
      expiresAt: '2026-12-31T00:00:00.000Z',
    })
    withDbMock.mockImplementation(async (fn) => await fn({}))

    const response = await action({
      context: {},
      request: new Request(
        'https://artifactshare.test/api/cli/auth/refresh-credentials',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer session-token' },
        },
      ),
    } as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      refresh_token: 'asr_refresh',
      refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
    })
    expect(issueCliRefreshCredentialMock).toHaveBeenCalledWith({}, 'user1')
  })

  test('rejects invalid non-API bearer credentials even if context has a cookie user', async () => {
    getSessionUserFromBearerMock.mockResolvedValue(null)

    const response = await action({
      context: { cookieUser: { id: 'cookie-user' } },
      request: new Request(
        'https://artifactshare.test/api/cli/auth/refresh-credentials',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer not-a-session-token' },
        },
      ),
    } as never)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'CLI session bearer token is invalid.',
      },
    })
    expect(issueCliRefreshCredentialMock).not.toHaveBeenCalled()
  })

  test('rejects non-POST requests', async () => {
    const response = await action({
      context: {},
      request: new Request(
        'https://artifactshare.test/api/cli/auth/refresh-credentials',
      ),
    } as never)

    expect(response.status).toBe(405)
  })

  test('rejects requests without a bearer token', async () => {
    const response = await action({
      context: {},
      request: new Request(
        'https://artifactshare.test/api/cli/auth/refresh-credentials',
        { method: 'POST' },
      ),
    } as never)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'CLI session bearer token is required.',
      },
    })
  })

  test('rejects API token bearer credentials', async () => {
    const response = await action({
      context: {},
      request: new Request(
        'https://artifactshare.test/api/cli/auth/refresh-credentials',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ast_api_token' },
        },
      ),
    } as never)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'API tokens cannot issue CLI refresh credentials.',
      },
    })
  })

  test('rejects refreshed CLI session bearer credentials', async () => {
    const response = await action({
      context: {},
      request: new Request(
        'https://artifactshare.test/api/cli/auth/refresh-credentials',
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ass_refreshed_session' },
        },
      ),
    } as never)

    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({
      error: {
        code: 'forbidden',
        message: 'Refreshed CLI sessions cannot issue CLI refresh credentials.',
      },
    })
    expect(getSessionUserFromBearerMock).not.toHaveBeenCalled()
    expect(issueCliRefreshCredentialMock).not.toHaveBeenCalled()
  })
})
