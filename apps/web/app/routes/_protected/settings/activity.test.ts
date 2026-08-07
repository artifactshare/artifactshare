import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(() => ({ id: 'u1', workspaceId: 'ws1' })),
  workspaceAdminQuery: vi.fn(),
  loadAuditEventsPage: vi.fn(),
}))

vi.mock('~/middleware/context', () => ({ requireUser: mocks.requireUser }))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/access.server', () => ({
  workspaceAdminQuery: mocks.workspaceAdminQuery,
}))
vi.mock('~/services/team-management.server', () => ({
  loadAuditEventsPage: mocks.loadAuditEventsPage,
}))

import { loader } from './activity'

describe('/settings/activity loader', () => {
  test('redirects non-admin users to settings', async () => {
    mocks.workspaceAdminQuery.mockReturnValueOnce({
      executeTakeFirst: vi.fn().mockResolvedValue(null),
    })

    await expect(
      loader({
        context: {},
        request: new Request('https://example.test/settings/activity'),
      } as never),
    ).rejects.toMatchObject({ status: 302, headers: expect.any(Headers) })
    expect(mocks.loadAuditEventsPage).not.toHaveBeenCalled()
  })

  test('loads activity data for admins', async () => {
    const data = { events: [], total: 0, page: 1 }
    mocks.workspaceAdminQuery.mockReturnValueOnce({
      executeTakeFirst: vi.fn().mockResolvedValue({ user_id: 'u1' }),
    })
    mocks.loadAuditEventsPage.mockResolvedValueOnce(data)

    await expect(
      loader({
        context: {},
        request: new Request('https://example.test/settings/activity?page=2'),
      } as never),
    ).resolves.toEqual(data)
    expect(mocks.loadAuditEventsPage).toHaveBeenCalledWith({}, 'ws1', 2)
  })
})
