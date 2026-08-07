import { describe, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  artifacts: vi.fn(),
  projects: vi.fn(),
}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ workspaceId: 'ws1' }),
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/access.server', () => ({
  isTeamWorkspaceAdmin: mocks.admin,
  requireInventoryAccess: async () => undefined,
}))
vi.mock('~/services/team-management.server', () => ({
  loadWorkspaceInventoryArtifactsPage: mocks.artifacts,
  loadWorkspaceInventoryProjectsPage: mocks.projects,
  parseInventoryArtifactsFilters: (p: URLSearchParams) => ({
    visibility: p.get('visibility') === 'link' ? 'link' : 'all',
    sort: p.get('sort') === 'size' ? 'size' : 'updated',
    page: 1,
  }),
}))
import { loader } from './artifacts'
describe('inventory artifacts loader', () => {
  test('loads artifacts only', async () => {
    mocks.admin.mockResolvedValue(true)
    mocks.artifacts.mockResolvedValue({ artifacts: [], total: 0, page: 1 })
    await loader({
      context: {},
      request: new Request(
        'https://x/settings/inventory/artifacts?visibility=link&sort=size',
      ),
    } as never)
    expect(mocks.artifacts).toHaveBeenCalledWith({}, 'ws1', {
      visibility: 'link',
      sort: 'size',
      page: 1,
    })
    expect(mocks.projects).not.toHaveBeenCalled()
  })
})
