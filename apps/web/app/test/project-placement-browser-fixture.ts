import { listMoveDestinations } from '~/services/shareables.server'
import { env } from 'cloudflare:workers'
import type { SessionUser } from '~/lib/user'
import { listProjectCandidates } from '~/services/project-candidates.server'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from './sqlite-fixture'

// Run the actual destination query on the server; never send a hand-filtered
// list to the browser, which would hide regressions in authorization.
export function projectPlacementBrowserFixture(allowOther: boolean) {
  return withPlacementFixture(allowOther, ({ db }, owner) =>
    listMoveDestinations(db, owner, 'artifact'),
  )
}

export function projectPlacementCandidatesBrowserFixture(allowOther: boolean) {
  return withPlacementFixture(allowOther, async ({ db, sqlite }, owner) => {
    // Bot destination discovery requires a workspace admin. On plus, that
    // role alone still cannot place into another creator's private project.
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: owner.workspaceId,
        user_id: owner.id,
        role: 'admin',
        status: 'active',
        created_at: '2026-09-17T00:00:00.000Z',
        updated_at: '2026-09-17T00:00:00.000Z',
      })
      .execute()
    const previousDatabase = env.DB
    env.DB = createD1MockFromSqliteRef({
      current: sqlite,
    }) as unknown as D1Database
    try {
      return await listProjectCandidates({
        user: owner,
        purpose: 'bot-destination',
        query: '',
        cursor: null,
      })
    } finally {
      env.DB = previousDatabase
    }
  })
}

async function withPlacementFixture<T>(
  allowOther: boolean,
  query: (
    fixture: ReturnType<typeof createMigratedInMemoryDb>,
    owner: SessionUser,
  ) => Promise<T>,
) {
  const fixture = createMigratedInMemoryDb()
  const { db } = fixture
  const now = '2026-09-17T00:00:00.000Z'
  const owner: SessionUser = {
    id: 'placement-owner',
    workspaceId: 'placement-workspace',
    email: 'owner@example.com',
    emailVerified: true,
    name: 'Owner',
    image: null,
    hd: 'example.com',
    msTenantId: null,
    locale: 'en',
    kind: 'human',
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
    return await query(fixture, owner)
  } finally {
    await db.destroy()
  }
}
