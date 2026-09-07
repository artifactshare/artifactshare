import { beforeEach, describe, expect, test, vi } from 'vitest'

const requireUserMock = vi.hoisted(() => vi.fn())
const appealLinkSuspension = vi.hoisted(() => vi.fn())

vi.mock('~/middleware/auth', () => ({ requireUserApiMiddleware: vi.fn() }))
vi.mock('~/middleware/context', () => ({ requireUser: requireUserMock }))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/link-suspension.server', () => ({
  LINK_APPEAL_MESSAGE_MAX: 1000,
  appealLinkSuspension,
}))

import { action, loader } from './api.shareables.$id.appeal'

function post(body: unknown) {
  return new Request(
    'https://artifactshare.com/api/shareables/abc123def4/appeal',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    },
  )
}
const params = { id: 'abc123def4' }

describe('link appeal route', () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockReturnValue({ id: 'owner-1' })
    appealLinkSuspension.mockReset().mockResolvedValue({ kind: 'appealed' })
  })

  test('rejects GET and empty or oversized messages before touching the service', async () => {
    expect(loader().status).toBe(405)
    for (const body of [
      {},
      { message: '   ' },
      { message: 'x'.repeat(1001) },
      'not json',
    ]) {
      const response = await action({
        request: post(body),
        params,
        context: {},
      } as never)
      expect(response.status).toBe(400)
    }
    expect(appealLinkSuspension).not.toHaveBeenCalled()
  })

  test('records the owner appeal and maps the service outcomes', async () => {
    const ok = await action({
      request: post({ message: ' Our report. ' }),
      params,
      context: {},
    } as never)
    expect(ok.status).toBe(200)
    expect(appealLinkSuspension).toHaveBeenCalledWith(
      expect.anything(),
      { id: 'owner-1' },
      { shareableId: 'abc123def4', message: 'Our report.' },
    )
    for (const [kind, status] of [
      ['forbidden', 403],
      ['not-found', 404],
      ['not-suspended', 409],
      ['cooldown', 429],
    ] as const) {
      appealLinkSuspension.mockResolvedValueOnce({ kind })
      const response = await action({
        request: post({ message: 'again' }),
        params,
        context: {},
      } as never)
      expect(response.status).toBe(status)
    }
  })
})
