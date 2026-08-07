import { describe, expect, test, vi } from 'vitest'

const withDbMock = vi.hoisted(() => vi.fn())
const refreshCliSessionMock = vi.hoisted(() => vi.fn())

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
      expiresAt: '2026-06-28T00:00:00.000Z',
    })
    withDbMock.mockImplementation(async (fn) => await fn({}))

    const response = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'asr_refresh' }),
      }),
    } as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      access_token: 'ass_session',
      token_type: 'Bearer',
      expires_at: '2026-06-28T00:00:00.000Z',
    })
    expect(refreshCliSessionMock).toHaveBeenCalledWith({}, 'asr_refresh')
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

  test('rejects invalid refresh credentials without details', async () => {
    refreshCliSessionMock.mockResolvedValue({ kind: 'invalid' })
    withDbMock.mockImplementation(async (fn) => await fn({}))

    const response = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/refresh', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'asr_bad' }),
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
