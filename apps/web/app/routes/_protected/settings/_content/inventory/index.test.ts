import { describe, expect, test, vi } from 'vitest'
const admin = vi.hoisted(() => vi.fn())
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ workspaceId: 'ws1' }),
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/access.server', () => ({
  isTeamWorkspaceAdmin: admin,
  requireInventoryAccess: async () => undefined,
}))
import { loader } from './index'
describe('inventory index loader', () => {
  test('redirects to projects', async () => {
    admin.mockResolvedValue(true)
    await expect(
      loader({
        context: {},
        request: new Request('https://x/settings/inventory'),
      } as never),
    ).rejects.toSatisfy(
      (response: unknown) =>
        response instanceof Response &&
        response.status === 302 &&
        response.headers.get('Location') === '/settings/inventory/projects',
    )
  })
})
