import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserApiWithBearerMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({
  requireUserApiWithBearerMiddleware: requireUserApiWithBearerMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({
  requireUser: requireUserMock,
  getCliAuthority: vi.fn().mockReturnValue(null),
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

  test.each([
    ['personal', null, null, false],
    ['hosted domain', 'example.com', null, true],
    ['claimed domain', 'example.com', null, true],
    ['tenant only', null, 'ws1', true],
  ])(
    'reports workspace capability for %s',
    async (_name, hd, msTenantId, available) => {
      requireUserMock.mockReturnValue({
        id: 'u1',
        email: 'user@example.com',
        workspaceId: 'ws1',
        hd,
        msTenantId,
      })
      const response = await loader({ context: new Map() } as never)
      const body = (await response.json()) as {
        workspace: {
          id: string
          hosted_domain: string | null
          visibility_available: boolean
        }
      }
      expect(body.workspace).toEqual({
        id: 'ws1',
        hosted_domain: hd,
        visibility_available: available,
      })
      expect(body.workspace).not.toHaveProperty('msTenantId')
    },
  )

  test('returns the authenticated user and workspace', async () => {
    const response = await loader({ context: new Map() } as never)
    const body = (await response.json()) as {
      user: { id: string; email: string }
      workspace: { id: string; hosted_domain: string | null }
      auth: { kind: string }
    }

    expect(response.status).toBe(200)
    expect(body.user).toEqual({ id: 'u1', email: 'owner@example.com' })
    expect(body.workspace).toEqual({
      id: 'ws1',
      hosted_domain: 'example.com',
      visibility_available: true,
    })
    expect(body.auth.kind).toBe('bearer_or_session')
  })
})
