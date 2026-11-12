import { expect, test, vi } from 'vitest'
import * as access from '~/modules/access'
import { loadPublishedViewer } from './+published-viewer-loader-fixture'

test('published viewer fixture preserves access exports used by loader dependencies', async () => {
  const original =
    await vi.importActual<typeof import('~/modules/access')>('~/modules/access')
  expect(access.workspaceAccessRevokedSql).toBe(
    original.workspaceAccessRevokedSql,
  )
  expect(Object.keys(access).sort()).toEqual(Object.keys(original).sort())
})

test('viewer loader distinguishes successful empty grants from unavailable or redacted evidence', async () => {
  const options = { locale: 'en' as const, scheduled: false, historical: false }
  const owner = await loadPublishedViewer({ ...options, persona: 'owner' })
  expect(owner.artifact.hasDirectGrants).toBe(false)
  const { listGrants } = await import('~/services/shareables.server')
  vi.mocked(listGrants).mockResolvedValueOnce({ kind: 'not-found' })
  const failed = await loadPublishedViewer({ ...options, persona: 'owner' })
  expect(failed.artifact.grants).toEqual([])
  expect(failed.artifact.hasDirectGrants).toBeUndefined()
  const viewer = await loadPublishedViewer({ ...options, persona: 'member' })
  expect(viewer.artifact.grants).toEqual([])
  expect(viewer.artifact.hasDirectGrants).toBeUndefined()
})
