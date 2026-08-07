import { RouterContextProvider } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { userContext } from '~/middleware/context'

const { markPendingSignupTracked } = vi.hoisted(() => ({
  markPendingSignupTracked: vi.fn(),
}))
vi.mock('~/services/signup-analytics.server', () => ({
  markPendingSignupTracked,
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))

import { action } from './set-analytics-tracked'

const user = {
  id: 'user-1',
  email: 'user@example.com',
  emailVerified: true,
  name: 'User',
  image: null,
  workspaceId: 'workspace-1',
  hd: null,
  msTenantId: null,
  locale: null,
}

function args(site: string, withUser: boolean) {
  const context = new RouterContextProvider()
  if (withUser) context.set(userContext, user)
  return {
    request: new Request('https://artifactshare.com/set-analytics-tracked', {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': site },
    }),
    url: new URL('https://artifactshare.com/set-analytics-tracked'),
    params: {},
    pattern: '/set-analytics-tracked',
    context,
  } as Parameters<typeof action>[0]
}

describe('/set-analytics-tracked action', () => {
  beforeEach(() => markPendingSignupTracked.mockClear())

  it('rejects cross-site requests', async () => {
    const response = await action(args('cross-site', true))
    expect(response.init?.status).toBe(403)
  })

  it('rejects anonymous same-origin requests', async () => {
    const response = await action(args('same-origin', false))
    expect(response.init?.status).toBe(401)
  })

  it('marks the signup and clears first-touch', async () => {
    const response = await action(args('same-origin', true))
    expect(markPendingSignupTracked).toHaveBeenCalledWith(
      {},
      'user-1',
      expect.any(String),
    )
    const cookie = new Headers(response.init?.headers).get('Set-Cookie')
    expect(cookie).toContain('__as_first_touch=')
    expect(cookie).toContain('Max-Age=0')
  })
})
