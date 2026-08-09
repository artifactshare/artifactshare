import { describe, expect, test, vi } from 'vitest'

const withDbMock = vi.hoisted(() => vi.fn())
const refreshCliSessionMock = vi.hoisted(() => vi.fn())

vi.mock('cloudflare:workers', () => ({
  env: { BETTER_AUTH_SECRET: 'test-secret' },
}))

vi.mock('~/services/db.server', () => ({
  withDb: withDbMock,
}))

vi.mock('~/services/cli-refresh-credentials.server', () => ({
  refreshCliSession: refreshCliSessionMock,
}))

const { action } = await import('./api.cli.auth.refresh')

describe('/api/cli/auth/refresh', () => {
  test('returns a new bearer session for a valid refresh credential', async () => {
    refreshCliSessionMock.mockResolvedValue({
      kind: 'ok',
      sessionToken: 'ass_session',
      sessionExpiresAt: '2026-06-28T00:00:00.000Z',
      refreshToken: 'asr_rotated',
      refreshExpiresAt: '2026-12-31T00:00:00.000Z',
    })
    withDbMock.mockImplementation(async (fn) => await fn({}))

    const response = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({
          refresh_token: 'asr_refresh',
          rotation_request_id: 'rotation-1',
        }),
      }),
    } as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      access_token: 'ass_session',
      token_type: 'Bearer',
      expires_at: '2026-06-28T00:00:00.000Z',
      refresh_token: 'asr_rotated',
      refresh_token_expires_at: '2026-12-31T00:00:00.000Z',
    })
    expect(refreshCliSessionMock).toHaveBeenCalledWith(
      {},
      'asr_refresh',
      'rotation-1',
      'test-secret',
    )
  })

  test('rejects invalid request payloads', async () => {
    const response = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: '' }),
      }),
    } as never)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid-request',
        message: 'Invalid request payload.',
      },
    })
  })

  test('accepts the legacy request shape during CLI rollout', async () => {
    refreshCliSessionMock.mockResolvedValue({ kind: 'invalid' })
    withDbMock.mockImplementation(async (fn) => await fn({}))
    await action({
      request: new Request('https://artifactshare.test/api/cli/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'asr_legacy' }),
      }),
    } as never)

    expect(refreshCliSessionMock).toHaveBeenCalledWith(
      {},
      'asr_legacy',
      null,
      'test-secret',
    )
  })

  test('rejects invalid refresh credentials without details', async () => {
    refreshCliSessionMock.mockResolvedValue({ kind: 'invalid' })
    withDbMock.mockImplementation(async (fn) => await fn({}))

    const response = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({
          refresh_token: 'asr_bad',
          rotation_request_id: 'rotation-bad',
        }),
      }),
    } as never)

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      error: {
        code: 'unauthorized',
        message: 'Refresh credential is invalid.',
      },
    })
  })

  test('rejects non-POST requests', async () => {
    const response = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/refresh'),
    } as never)

    expect(response.status).toBe(405)
  })
})
