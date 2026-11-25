import { RouterContextProvider } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import { serviceCallValues } from '~/test/service-call'
import { settingsAdminGate } from '../+lib/settings-admin.server'

const mocks = vi.hoisted(() => ({
  requireUser: vi.fn(() => ({ id: 'u1', workspaceId: 'ws1' })),
  loadAuditEventsPage: vi.fn(),
}))

vi.mock('~/middleware/context', () => ({ requireUser: mocks.requireUser }))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/team-management.server', () => ({
  loadAuditEventsPage: mocks.loadAuditEventsPage,
}))

import { loader } from './activity'

// Refusals are the admin gate's, covered with the real route topology in
// settings-admin-gate.test.ts.
describe('/settings/activity loader', () => {
  test('loads the requested page of activity for an admitted admin', async () => {
    const data = { events: [], total: 0, page: 1 }
    mocks.loadAuditEventsPage.mockResolvedValueOnce(data)
    const context = new RouterContextProvider()
    context.set(settingsAdminGate, 'allowed')
    const url = new URL('https://example.test/settings/activity?page=2')

    await expect(
      loader({
        context,
        request: new Request(url),
        params: {},
        url,
        pattern: '/settings/activity',
      }),
    ).resolves.toEqual(data)
    expect(serviceCallValues(mocks.loadAuditEventsPage.mock.calls[0])).toEqual(
      expect.arrayContaining(['ws1', 2]),
    )
  })
})
