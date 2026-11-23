import { RouterContextProvider } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import { settingsAdminGate } from '../../+lib/settings-admin.server'
const mocks = vi.hoisted(() => ({
  artifacts: vi.fn(),
  projects: vi.fn(),
}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ workspaceId: 'ws1' }),
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
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
    mocks.artifacts.mockResolvedValue({ artifacts: [], total: 0, page: 1 })
    const context = new RouterContextProvider()
    context.set(settingsAdminGate, 'allowed')
    await loader({
      context,
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
