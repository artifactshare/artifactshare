import { describe, expect, test, vi } from 'vitest'

const authMocks = vi.hoisted(() => ({
  verifyJwsAccessToken: vi.fn(),
  getLocalJwksWithHangDetection: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    APP_ENV: 'development',
    BETTER_AUTH_URL: 'https://artifactshare.test',
    MCP_DEV_TOKEN: 'dev-token',
    DB: {},
  },
}))

vi.mock('better-auth/oauth2', () => ({
  verifyJwsAccessToken: authMocks.verifyJwsAccessToken,
}))

vi.mock('~/services/auth.server', () => ({
  getLocalJwksWithHangDetection: authMocks.getLocalJwksWithHangDetection,
}))

import { handleMcpRequest } from './transport.server'

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
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      )

      expect(response.status).toBe(405)
      expect(response.headers.get('Allow')).toBe('POST')
      expect(authMocks.verifyJwsAccessToken).not.toHaveBeenCalled()
      expect(authMocks.getLocalJwksWithHangDetection).not.toHaveBeenCalled()
    },
  )

  test('keeps POST on the existing authentication path', async () => {
    const response = await handleMcpRequest(
      new Request('https://artifactshare.test/mcp', { method: 'POST' }),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain(
      'https://artifactshare.test/.well-known/oauth-protected-resource/mcp',
    )
  })
})
