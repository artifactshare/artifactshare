import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

// projects.server never reads the Workers env; a bare mock keeps the import
// graph resolvable, matching the other projects.server tests.
vi.mock('cloudflare:workers', () => ({ env: {} }))

import { visibleShareableToViewer } from './projects.server'

const TS = '2026-06-14T00:00:00.000Z'
const OWNER = { id: 'u-owner', email: 'owner@example.com', emailVerified: true }

// Runs the predicate exactly the way every caller must: scoped to one workspace.
async function visibleIds(
  db: Kysely<DB>,
  workspaceId: string,
  viewer: {
    id: string
    email: string
    emailVerified: boolean
  },
  now = TS,
) {
  const rows = await db
    .selectFrom('shareables')
    .select('shareables.id')
    .where('shareables.workspace_id', '=', workspaceId)
    .where((eb) => visibleShareableToViewer(eb, viewer, now))
    .orderBy('shareables.id', 'asc')
    .execute()
  return rows.map((r) => r.id)
}

describe('visibleShareableToViewer', () => {
  let db: Kysely<DB>
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('a normal viewer sees their own files and workspace-visible files, not others private', async () => {
    expect(await visibleIds(db, 'ws-a', OWNER)).toEqual([
      's-mine-private',
      's-other-workspace',
    ])
  })

  test('a grant on a stored mixed-case email still reveals the private file', async () => {
    // Without a grant the owner cannot see u-other's private file (asserted above).
    // The grant is stored with mixed case while the viewer email is lowercase, so
    // matching must lower() the stored column, not just the viewer input.
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 's-other-private',
        granted_email: 'Owner@Example.com',
        granted_at: TS,
        granted_by: 'u-other',
      })
      .execute()

    expect(await visibleIds(db, 'ws-a', OWNER)).toContain('s-other-private')
  })

  test('an unverified viewer does not see a grant-shared file', async () => {
    // Security gate: the grant matches the viewer's email only when it's proven.
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 's-other-private',
        granted_email: 'owner@example.com',
        granted_at: TS,
        granted_by: 'u-other',
      })
      .execute()

    const unverified = { ...OWNER, emailVerified: false }
    expect(await visibleIds(db, 'ws-a', unverified)).not.toContain(
      's-other-private',
    )
    // The grant still works once the same email is verified.
    expect(await visibleIds(db, 'ws-a', OWNER)).toContain('s-other-private')
  })

  test('a private project file is hidden until the viewer is related to that project', async () => {
    expect(await visibleIds(db, 'ws-a', OWNER)).not.toContain(
      's-project-private',
    )

    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'default-target',
        project_container_id: 'project-private',
        email: OWNER.email,
        role: 'viewer',
        display_name: null,
        created_by_id: 'u-other',
        created_at: TS,
        updated_at: TS,
      })
      .execute()

    const visible = await visibleIds(db, 'ws-a', OWNER)
    expect(visible).toContain('s-project-private')
    expect(visible).not.toContain('s-other-project')
    expect(visible).not.toContain('s-project-elsewhere')
  })

  test('a team workspace admin sees project-visible files in private projects', async () => {
    const admin = {
      id: 'u-admin',
      email: 'admin@example.com',
      emailVerified: true,
    }
    const visible = await visibleIds(db, 'ws-a', admin)
    expect(visible).toContain('s-project-private')
    expect(visible).toContain('s-other-project')
    expect(visible).not.toContain('s-project-elsewhere')
  })

  test('requires callers to apply the workspace boundary separately', async () => {
    const unscoped = await db
      .selectFrom('shareables')
      .select('shareables.id')
      .where((eb) => visibleShareableToViewer(eb, OWNER))
      .orderBy('shareables.id', 'asc')
      .execute()

    expect(unscoped.map((row) => row.id)).toEqual(
      expect.arrayContaining(['s-elsewhere-workspace']),
    )
    expect(unscoped.map((row) => row.id)).not.toContain('s-elsewhere-link')
    const scoped = await visibleIds(db, 'ws-a', OWNER)
    expect(scoped).not.toContain('s-elsewhere-workspace')
    expect(scoped).not.toContain('s-elsewhere-link')
  })

  test('link access requires an enabled paid workspace and a valid expiry', async () => {
    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 1 })
      .where('id', '=', 'ws-a')
      .execute()
    await db
      .insertInto('shareables')
      .values([
        {
          ...shareable('link-unlimited', 'ws-a', 'u-other', 'inbox-a', 'link'),
          link_expires_at: null,
        },
        {
          ...shareable('link-future', 'ws-a', 'u-other', 'inbox-a', 'link'),
          link_expires_at: '2026-06-15T00:00:00.000Z',
        },
        {
          ...shareable('link-seconds', 'ws-a', 'u-other', 'inbox-a', 'link'),
          link_expires_at: '2026-06-15T00:00:00Z',
        },
        {
          ...shareable('link-expired', 'ws-a', 'u-other', 'inbox-a', 'link'),
          link_expires_at: '2026-06-13T00:00:00.000Z',
        },
        {
          ...shareable(
            'link-seconds-expired',
            'ws-a',
            'u-other',
            'inbox-a',
            'link',
          ),
          link_expires_at: '2026-06-14T00:00:00Z',
        },
        {
          ...shareable('link-invalid', 'ws-a', 'u-other', 'inbox-a', 'link'),
          link_expires_at: 'not-a-date',
        },
      ])
      .execute()

    expect(await visibleIds(db, 'ws-a', OWNER)).toEqual(
      expect.arrayContaining(['link-future', 'link-seconds', 'link-unlimited']),
    )
    expect(await visibleIds(db, 'ws-a', OWNER)).not.toContain('link-expired')
    expect(
      await visibleIds(db, 'ws-a', OWNER, '2026-06-14T00:00:00.500Z'),
    ).not.toContain('link-seconds-expired')
    expect(await visibleIds(db, 'ws-a', OWNER)).not.toContain('link-invalid')

    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 0 })
      .where('id', '=', 'ws-a')
      .execute()
    expect(await visibleIds(db, 'ws-a', OWNER)).not.toContain('link-unlimited')
    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 1, plan: 'free' })
      .where('id', '=', 'ws-a')
      .execute()
    expect(await visibleIds(db, 'ws-a', OWNER)).not.toContain('link-unlimited')
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus' })
      .where('id', '=', 'ws-a')
      .execute()
    expect(await visibleIds(db, 'ws-a', OWNER)).toContain('link-unlimited')
  })

  test('owner, verified grant, and active Team admin bypass an invalid link policy', async () => {
    await db
      .insertInto('shareables')
      .values([
        shareable('link-owned', 'ws-a', OWNER.id, 'inbox-a', 'link'),
        shareable('link-granted', 'ws-a', 'u-other', 'inbox-a', 'link'),
        shareable('link-admin', 'ws-a', 'u-other', 'inbox-a', 'link'),
      ])
      .execute()
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'link-granted',
        granted_email: OWNER.email,
        granted_at: TS,
        granted_by: 'u-other',
      })
      .execute()

    expect(await visibleIds(db, 'ws-a', OWNER)).toEqual(
      expect.arrayContaining(['link-owned', 'link-granted']),
    )
    expect(await visibleIds(db, 'ws-a', OWNER)).not.toContain('link-admin')
    expect(
      await visibleIds(db, 'ws-a', {
        id: 'u-admin',
        email: 'admin@example.com',
        emailVerified: true,
      }),
    ).toContain('link-admin')
    await db
      .updateTable('workspace_members')
      .set({ role: 'member' })
      .where('user_id', '=', 'u-admin')
      .execute()
    expect(
      await visibleIds(db, 'ws-a', {
        id: 'u-admin',
        email: 'admin@example.com',
        emailVerified: true,
      }),
    ).not.toContain('link-admin')
    await db
      .updateTable('workspace_members')
      .set({ role: 'admin' })
      .where('user_id', '=', 'u-admin')
      .execute()
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus' })
      .where('id', '=', 'ws-a')
      .execute()
    expect(
      await visibleIds(db, 'ws-a', {
        id: 'u-admin',
        email: 'admin@example.com',
        emailVerified: true,
      }),
    ).not.toContain('link-admin')
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', 'ws-a')
      .execute()
    await db
      .updateTable('workspace_members')
      .set({ status: 'removed' })
      .where('user_id', '=', 'u-admin')
      .execute()
    expect(
      await visibleIds(db, 'ws-a', {
        id: 'u-admin',
        email: 'admin@example.com',
        emailVerified: true,
      }),
    ).not.toContain('link-admin')
  })
})

async function seed(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values([
      workspace('ws-a', 'example.com', 'team'),
      workspace('ws-b', 'other.example'),
    ])
    .execute()
  await db
    .insertInto('users')
    .values([
      user('u-owner', 'owner@example.com', 'ws-a'),
      user('u-other', 'other@example.com', 'ws-a'),
      user('u-admin', 'admin@example.com', 'ws-a'),
      user('u-other-b', 'other-b@example.com', 'ws-b'),
    ])
    .execute()
  await db
    .insertInto('artifact_containers')
    .values([
      inbox('inbox-a', 'ws-a', 'u-owner'),
      inbox('inbox-b', 'ws-b', 'u-other-b'),
      project('project-private', 'ws-a', 'u-other'),
      project('project-other', 'ws-a', 'u-other'),
      project('project-elsewhere', 'ws-b', 'u-other'),
    ])
    .execute()
  const shareables = [
    shareable('s-mine-private', 'ws-a', 'u-owner', 'inbox-a', 'private'),
    shareable('s-other-private', 'ws-a', 'u-other', 'inbox-a', 'private'),
    shareable('s-other-workspace', 'ws-a', 'u-other', 'inbox-a', 'workspace'),
    shareable(
      's-elsewhere-workspace',
      'ws-b',
      'u-other-b',
      'inbox-b',
      'workspace',
    ),
    shareable('s-elsewhere-link', 'ws-b', 'u-other-b', 'inbox-b', 'link'),
    shareable(
      's-project-private',
      'ws-a',
      'u-other',
      'project-private',
      'project',
    ),
    shareable('s-other-project', 'ws-a', 'u-other', 'project-other', 'project'),
    shareable(
      's-project-elsewhere',
      'ws-b',
      'u-other',
      'project-elsewhere',
      'project',
    ),
  ]
  for (let index = 0; index < shareables.length; index += 4) {
    await db
      .insertInto('shareables')
      .values(shareables.slice(index, index + 4))
      .execute()
  }
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: 'ws-a',
      user_id: 'u-admin',
      role: 'admin',
      status: 'active',
      created_at: TS,
      updated_at: TS,
    })
    .execute()
}

function workspace(
  id: string,
  hd: string,
  plan: 'free' | 'plus' | 'team' = 'free',
) {
  return {
    id,
    hd,
    name: id,
    created_at: TS,
    plan,
    storage_quota_bytes: 104857600,
    storage_used_bytes: 0,
    storage_updated_at: TS,
  }
}

function project(id: string, workspaceId: string, creatorId: string) {
  return {
    id,
    workspace_id: workspaceId,
    kind: 'project' as const,
    owner_user_id: null,
    created_by_id: creatorId,
    name: id,
    description: null,
    base_visibility: 'private' as const,
    archived_at: null,
    created_at: TS,
    updated_at: TS,
  }
}

function user(id: string, email: string, workspaceId: string) {
  return {
    id,
    email,
    email_verified: 1,
    name: id,
    image: null,
    created_at: TS,
    updated_at: TS,
    workspace_id: workspaceId,
    locale: null,
  }
}

function inbox(id: string, workspaceId: string, ownerUserId: string) {
  return {
    id,
    workspace_id: workspaceId,
    kind: 'inbox' as const,
    owner_user_id: ownerUserId,
    created_by_id: ownerUserId,
    name: '未整理',
    description: null,
    base_visibility: 'workspace' as const,
    archived_at: null,
    created_at: TS,
    updated_at: TS,
  }
}

function shareable(
  id: string,
  workspaceId: string,
  ownerUserId: string,
  containerId: string,
  visibility: 'private' | 'workspace' | 'project' | 'link',
) {
  return {
    id,
    workspace_id: workspaceId,
    owner_user_id: ownerUserId,
    slug: null,
    name: id,
    derived_title: null,
    title_override: null,
    description: null,
    artifact_kind: 'html_page' as const,
    visibility,
    current_version_id: null,
    container_id: containerId,
    created_at: TS,
    updated_at: TS,
    last_accessed_at: null,
  }
}
