import { listMoveDestinations } from '~/services/shareables.server'
import { createMigratedInMemoryDb } from './sqlite-fixture'

// Run the actual destination query on the server; never send a hand-filtered
// list to the browser, which would hide regressions in authorization.
export async function projectPlacementBrowserFixture(allowOther: boolean) {
  const { db } = createMigratedInMemoryDb()
  const now = '2026-09-17T00:00:00.000Z'
  const owner = {
    id: 'placement-owner',
    workspaceId: 'placement-workspace',
    email: 'owner@example.com',
    emailVerified: true,
  }
  try {
    await db
      .insertInto('workspaces')
      .values({
        id: owner.workspaceId,
        name: 'Example workspace',
        hd: 'example.com',
        plan: 'plus',
        created_at: now,
        storage_updated_at: now,
      })
      .execute()
    await db
      .insertInto('users')
      .values(
        [owner.id, 'placement-other'].map((id) => ({
          id,
          workspace_id: owner.workspaceId,
          email: id === owner.id ? owner.email : 'other@example.com',
          email_verified: 1,
          name: id,
          created_at: now,
          updated_at: now,
        })),
      )
      .execute()
    await db
      .insertInto('artifact_containers')
      .values([
        {
          id: 'placement-home',
          workspace_id: owner.workspaceId,
          kind: 'inbox',
          base_visibility: 'private',
          name: 'Home',
          owner_user_id: owner.id,
          created_by_id: owner.id,
          created_at: now,
          updated_at: now,
        },
        ...['allowed', 'unavailable'].map((id) => ({
          id,
          workspace_id: owner.workspaceId,
          kind: 'project' as const,
          base_visibility: 'private' as const,
          name:
            id === 'allowed'
              ? 'Available destination'
              : 'Unavailable destination',
          created_by_id:
            id === 'allowed' || allowOther ? owner.id : 'placement-other',
          created_at: now,
          updated_at: now,
        })),
      ])
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'artifact',
        workspace_id: owner.workspaceId,
        owner_user_id: owner.id,
        container_id: 'placement-home',
        name: 'Example',
        artifact_kind: 'html_page',
        visibility: 'private',
        created_at: now,
        updated_at: now,
      })
      .execute()
    return await listMoveDestinations(db, owner, 'artifact')
  } finally {
    await db.destroy()
  }
}
