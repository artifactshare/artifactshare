import { describe, expect, test, vi } from 'vitest'

const withDbMock = vi.hoisted(() => vi.fn())
const revokeMock = vi.hoisted(() => vi.fn())

vi.mock('~/services/db.server', () => ({ withDb: withDbMock }))
vi.mock('~/services/cli-refresh-credentials.server', () => ({
  revokeCliRefreshCredential: revokeMock,
}))

const { action } = await import('./api.cli.auth.revoke')

describe('/api/cli/auth/revoke', () => {
  test('revokes a valid refresh credential', async () => {
    revokeMock.mockResolvedValue('ok')
    withDbMock.mockImplementation(async (fn) => await fn({}))
    const response = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/revoke', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'asr_refresh' }),
      }),
    } as never)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ revoked: true })
    expect(revokeMock).toHaveBeenCalledWith({}, 'asr_refresh')
  })

  test('rejects an unknown credential without leaking details', async () => {
    revokeMock.mockResolvedValue('invalid')
    withDbMock.mockImplementation(async (fn) => await fn({}))
    const response = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/revoke', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'asr_unknown' }),
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

  test('does not report success when credential lineage is inconsistent', async () => {
    revokeMock.mockResolvedValue('inconsistent')
    withDbMock.mockImplementation(async (fn) => await fn({}))
    const response = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/revoke', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'asr_inconsistent' }),
      }),
    } as never)

    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({
      error: {
        code: 'service-error',
        message: 'Refresh credential could not be safely revoked.',
      },
    })
  })

  test('rejects invalid payloads and methods', async () => {
    const invalid = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/revoke', {
        method: 'POST',
        body: '{}',
      }),
    } as never)
    expect(invalid.status).toBe(400)

    const method = await action({
      request: new Request('https://artifactshare.test/api/cli/auth/revoke'),
    } as never)
    expect(method.status).toBe(405)
  })
})
