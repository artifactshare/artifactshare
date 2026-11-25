import { RouterContextProvider } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import { serviceCallValues } from '~/test/service-call'
import { settingsAdminGate } from '../../+lib/settings-admin.server'
const mocks = vi.hoisted(() => ({
  projects: vi.fn(),
  artifacts: vi.fn(),
}))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ workspaceId: 'ws1' }),
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/services/team-management.server', () => ({
  loadWorkspaceInventoryProjectsPage: mocks.projects,
  loadWorkspaceInventoryArtifactsPage: mocks.artifacts,
}))
import { loader } from './projects'
describe('inventory projects loader', () => {
  test('loads projects only', async () => {
    mocks.projects.mockResolvedValue({ projects: [], total: 0, page: 1 })
    const context = new RouterContextProvider()
    context.set(settingsAdminGate, 'allowed')
    await loader({
      context,
      request: new Request('https://x/settings/inventory/projects?page=2'),
    } as never)
    expect(serviceCallValues(mocks.projects.mock.calls[0])).toEqual(
      expect.arrayContaining(['ws1', 2]),
    )
    expect(mocks.artifacts).not.toHaveBeenCalled()
  })
})
