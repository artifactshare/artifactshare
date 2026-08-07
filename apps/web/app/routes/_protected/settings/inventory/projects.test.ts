import { describe, expect, test, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  admin: vi.fn(),
  projects: vi.fn(),
  artifacts: vi.fn(),
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
  loadWorkspaceInventoryProjectsPage: mocks.projects,
  loadWorkspaceInventoryArtifactsPage: mocks.artifacts,
}))
import { loader } from './projects'
describe('inventory projects loader', () => {
  test('loads projects only', async () => {
    mocks.admin.mockResolvedValue(true)
    mocks.projects.mockResolvedValue({ projects: [], total: 0, page: 1 })
    await loader({
      context: {},
      request: new Request('https://x/settings/inventory/projects?page=2'),
    } as never)
    expect(mocks.projects).toHaveBeenCalledWith({}, 'ws1', 2)
    expect(mocks.artifacts).not.toHaveBeenCalled()
  })
})
