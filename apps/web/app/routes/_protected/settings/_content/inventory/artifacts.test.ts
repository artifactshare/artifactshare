import { RouterContextProvider } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import { serviceCallValues } from '~/test/service-call'
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
    expect(serviceCallValues(mocks.artifacts.mock.calls[0])).toEqual(
      expect.arrayContaining(['ws1', 'link', 'size', 1]),
    )
    expect(mocks.projects).not.toHaveBeenCalled()
  })
})
