import { beforeEach, describe, expect, test, vi } from 'vitest'

const ctxContextMock = vi.hoisted(() => Symbol('ctx'))
const processAccessRequestMock = vi.hoisted(() => vi.fn())
const countReceivedAccessRequestsMock = vi.hoisted(() => vi.fn())
const sendResolutionMock = vi.hoisted(() => vi.fn())
const dbMock = vi.hoisted(() => ({ kind: 'db' }))

vi.mock('~/middleware/context', () => ({
  ctxContext: ctxContextMock,
  requireUser: () => ({
    id: 'handler',
    email: 'handler@example.com',
    emailVerified: true,
    workspaceId: 'workspace-a',
  }),
}))
vi.mock('~/middleware/auth', () => ({ requireUserApiMiddleware: vi.fn() }))
vi.mock('~/services/db.server', () => ({ createDb: () => dbMock }))
vi.mock('~/services/access-requests.server', () => ({
  processAccessRequest: processAccessRequestMock,
  countReceivedAccessRequests: countReceivedAccessRequestsMock,
}))
vi.mock('~/services/access-request-resolution-notifications.server', () => ({
  sendAccessRequestResolutionNotifications: sendResolutionMock,
}))

import { action } from './api.access-requests.$id'

describe('access request decision API', () => {
  beforeEach(() => {
    processAccessRequestMock.mockReset()
    countReceivedAccessRequestsMock.mockReset().mockResolvedValue(0)
    sendResolutionMock.mockReset().mockResolvedValue(undefined)
  })

  test('schedules a result notification only for the committed transition', async () => {
    processAccessRequestMock.mockResolvedValue({
      kind: 'processed',
      status: 'approved',
    })
    const waitUntil = vi.fn()
    const response = await actionArgs(waitUntil)

    expect(response.status).toBe(200)
    expect(sendResolutionMock).toHaveBeenCalledWith(dbMock, {
      requestId: 'request-1',
      status: 'approved',
      resolvedByUserId: 'handler',
      origin: 'https://artifactshare.test',
    })
    expect(waitUntil).toHaveBeenCalledWith(
      sendResolutionMock.mock.results[0]?.value,
    )
  })

  test('does not schedule a duplicate for an already processed request', async () => {
    processAccessRequestMock.mockResolvedValue({
      kind: 'already-processed',
      status: 'approved',
    })
    const waitUntil = vi.fn()
    const response = await actionArgs(waitUntil)

    expect(response.status).toBe(200)
    expect(sendResolutionMock).not.toHaveBeenCalled()
    expect(waitUntil).not.toHaveBeenCalled()
  })
})

async function actionArgs(waitUntil: (promise: Promise<unknown>) => void) {
  return await action({
    request: new Request(
      'https://transport.test/api/access-requests/request-1.data',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', scope: 'artifact' }),
      },
    ),
    params: { id: 'request-1' },
    context: new Map([[ctxContextMock, { waitUntil }]]),
    url: new URL('https://artifactshare.test/api/access-requests/request-1'),
  } as never)
}
