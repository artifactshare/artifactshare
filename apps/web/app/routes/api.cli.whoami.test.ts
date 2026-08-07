import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
}))

import { loader, middleware } from './api.cli.whoami'

describe('/api/cli/whoami', () => {
  beforeEach(() => {
    requireUserApiWithBearerMiddlewareMock.mockReset()
    requireUserMock.mockReset()
    requireUserMock.mockReturnValue({
      id: 'u1',
      email: 'owner@example.com',
      workspaceId: 'ws1',
      hd: 'example.com',
    })
  })

  test('returns the authenticated user and workspace', async () => {
    const response = await loader({ context: new Map() } as never)
    const body = (await response.json()) as {
      user: { id: string; email: string }
      workspace: { id: string; hosted_domain: string | null }
      auth: { kind: string }
    }

    expect(response.status).toBe(200)
    expect(body.user).toEqual({ id: 'u1', email: 'owner@example.com' })
    expect(body.workspace).toEqual({ id: 'ws1', hosted_domain: 'example.com' })
    expect(body.auth.kind).toBe('bearer_or_session')
  })
})
