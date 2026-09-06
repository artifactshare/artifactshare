import { beforeEach, describe, expect, test, vi } from 'vitest'

const envMock = vi.hoisted(() => ({
  LINK_ABUSE_JUDGMENT_WORKFLOW: {},
  LINK_ABUSE_JUDGMENT_COOLDOWN_MINUTES: '360',
  LINK_ABUSE_MANUAL_COOLDOWN_MINUTES: '5',
}))
const requireUserApiMiddlewareMock = vi.hoisted(() => vi.fn())
const requireUserMock = vi.hoisted(() => vi.fn())
const isWorkspaceAdminMock = vi.hoisted(() => vi.fn())
const startLinkAbuseJudgmentMock = vi.hoisted(() => vi.fn())
const shareableRef = vi.hoisted(() => ({
  current: null as {
    owner_user_id: string
    workspace_id: string
    visibility: string
  } | null,
}))

vi.mock('cloudflare:workers', () => ({ env: envMock }))
vi.mock('~/middleware/auth', () => ({
  requireUserApiMiddleware: requireUserApiMiddlewareMock,
}))
vi.mock('~/middleware/context', () => ({ requireUser: requireUserMock }))
vi.mock('~/services/access.server', () => ({
  isWorkspaceAdmin: isWorkspaceAdminMock,
}))
vi.mock('~/services/link-abuse-signals.server', () => ({
  startLinkAbuseJudgment: startLinkAbuseJudgmentMock,
}))
vi.mock('~/services/db.server', () => ({
  createDb: () => {
    const query = {
      select: () => query,
      where: () => query,
      executeTakeFirst: async () => shareableRef.current,
    }
    return { selectFrom: () => query }
  },
}))

import { action, loader, middleware } from './api.shareables.$id.abuse-check'

function actionArgs(method = 'POST') {
  return {
    request: new Request(
      'https://artifactshare.com/api/shareables/art1/abuse-check',
      {
        method,
      },
    ),
    params: { id: 'art1' },
    context: {},
  } as never
}

describe('manual link abuse check route', () => {
  beforeEach(() => {
    requireUserMock.mockReset().mockReturnValue({
      id: 'owner-1',
      workspaceId: 'ws-1',
    })
    isWorkspaceAdminMock.mockReset().mockResolvedValue(false)
    startLinkAbuseJudgmentMock
      .mockReset()
      .mockResolvedValue({ kind: 'started' })
    shareableRef.current = {
      owner_user_id: 'owner-1',
      workspace_id: 'ws-1',
      visibility: 'link',
    }
  })

  test('uses signed-in API middleware and lets the owner start a manual check', async () => {
    expect(middleware).toEqual([requireUserApiMiddlewareMock])
    const response = await action(actionArgs())
    expect(response.status).toBe(202)
    expect(startLinkAbuseJudgmentMock).toHaveBeenCalledWith(
      expect.anything(),
      envMock,
      {
        shareableId: 'art1',
        trigger: 'manual',
        detail: 'owner_requested',
      },
    )
  })

  test('allows an active workspace admin', async () => {
    requireUserMock.mockReturnValue({ id: 'admin-1', workspaceId: 'ws-1' })
    isWorkspaceAdminMock.mockResolvedValue(true)
    const response = await action(actionArgs())
    expect(response.status).toBe(202)
    expect(isWorkspaceAdminMock).toHaveBeenCalled()
  })

  test('reports the manual cooldown with a retry delay', async () => {
    startLinkAbuseJudgmentMock.mockResolvedValue({
      kind: 'cooldown',
      retryAfterSeconds: 73,
    })
    const response = await action(actionArgs())
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('73')
  })

  test('reports a workflow start failure', async () => {
    startLinkAbuseJudgmentMock.mockResolvedValue({ kind: 'failed' })
    const response = await action(actionArgs())
    expect(response.status).toBe(503)
  })

  test('hides the artifact from a non-owner member', async () => {
    requireUserMock.mockReturnValue({ id: 'member-1', workspaceId: 'ws-1' })
    const response = await action(actionArgs())
    expect(response.status).toBe(404)
    expect(startLinkAbuseJudgmentMock).not.toHaveBeenCalled()
  })

  test('hides a non-link artifact from the manual judgment route', async () => {
    shareableRef.current = {
      owner_user_id: 'owner-1',
      workspace_id: 'ws-1',
      visibility: 'private',
    }
    const response = await action(actionArgs())
    expect(response.status).toBe(404)
    expect(await response.json()).toMatchObject({
      error: { code: 'not-found' },
    })
    expect(startLinkAbuseJudgmentMock).not.toHaveBeenCalled()
  })

  test('exports the GET routing path as a standard JSON 405', async () => {
    const response = loader()
    expect(response.status).toBe(405)
    expect(await response.json()).toMatchObject({
      error: { code: 'method-not-allowed' },
    })
  })
})
