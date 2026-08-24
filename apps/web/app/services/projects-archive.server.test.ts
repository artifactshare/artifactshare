import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

// projects.server never reads the Workers env, but a bare mock keeps the import
// graph resolvable in the same way the move test does.
vi.mock('cloudflare:workers', () => ({ env: {} }))

import {
  archiveProjectContainer,
  deleteProjectContainer,
  listArchivedWorkspaceProjects,
  listWorkspaceProjects,
  unarchiveProjectContainer,
} from './projects.server'

const TS = '2026-06-03T00:00:00.000Z'
const OWNER = { id: 'u-owner', email: 'owner@example.com', emailVerified: true }
const OTHER = { id: 'u-other', email: 'other@example.com' }
const ADMIN = { id: 'u-admin', email: 'admin@example.com' }
const WS = 'ws-a'

describe('archiveProjectContainer', () => {
  let db: Kysely<DB>
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('creator archives a project; it leaves the active list and joins archived', async () => {
    const result = await archiveProjectContainer(db, WS, 'project-a', OWNER.id)
    expect(result).toBe('ok')
    expect(await archivedAtOf(db, 'project-a')).not.toBeNull()

    const active = await listWorkspaceProjects(db, WS, OWNER)
    expect(active.map((p) => p.id)).not.toContain('project-a')
    const archived = await listArchivedWorkspaceProjects(db, WS, OWNER)
    expect(archived.map((p) => p.id)).toContain('project-a')
  })

  test('a workspace admin may archive a project they did not create', async () => {
    const result = await archiveProjectContainer(db, WS, 'project-a', ADMIN.id)
    expect(result).toBe('ok')
    expect(await archivedAtOf(db, 'project-a')).not.toBeNull()
  })

  test('a non-creator non-admin cannot archive', async () => {
    const result = await archiveProjectContainer(db, WS, 'project-a', OTHER.id)
    expect(result).toBe('forbidden')
    expect(await archivedAtOf(db, 'project-a')).toBeNull()
  })

  test('archiving a missing project returns not-found', async () => {
    const result = await archiveProjectContainer(db, WS, 'nope', OWNER.id)
    expect(result).toBe('not-found')
  })

  test('a project in another workspace is not found', async () => {
    const result = await archiveProjectContainer(db, WS, 'project-b', OWNER.id)
    expect(result).toBe('not-found')
  })

  test('archiving is idempotent', async () => {
    await archiveProjectContainer(db, WS, 'project-a', OWNER.id)
    const again = await archiveProjectContainer(db, WS, 'project-a', OWNER.id)
    expect(again).toBe('ok')
  })

  test('archiving does not move the contained shareables', async () => {
    await archiveProjectContainer(db, WS, 'project-a', OWNER.id)
    expect(await containerOf(db, 's1')).toBe('project-a')
  })
})

describe('unarchiveProjectContainer', () => {
  let db: Kysely<DB>
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
    await archiveProjectContainer(db, WS, 'project-a', OWNER.id)
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('creator restores an archived project to the active list', async () => {
    const result = await unarchiveProjectContainer(
      db,
      WS,
      'project-a',
      OWNER.id,
    )
    expect(result).toBe('ok')
    expect(await archivedAtOf(db, 'project-a')).toBeNull()
    const active = await listWorkspaceProjects(db, WS, OWNER)
    expect(active.map((p) => p.id)).toContain('project-a')
  })

  test('restore rejects a name already used by an active project', async () => {
    await db
      .insertInto('artifact_containers')
      .values({
        ...project('project-conflict', WS, OWNER.id),
        name: 'PROJECT-A',
      })
      .execute()

    await expect(
      unarchiveProjectContainer(db, WS, 'project-a', OWNER.id),
    ).resolves.toEqual({ kind: 'project-name-conflict' })
    expect(await archivedAtOf(db, 'project-a')).not.toBeNull()
  })

  test('admin may restore a project they did not create', async () => {
    const result = await unarchiveProjectContainer(
      db,
      WS,
      'project-a',
      ADMIN.id,
    )
    expect(result).toBe('ok')
    expect(await archivedAtOf(db, 'project-a')).toBeNull()
  })

  test('a non-creator non-admin cannot restore', async () => {
    const result = await unarchiveProjectContainer(
      db,
      WS,
      'project-a',
      OTHER.id,
    )
    expect(result).toBe('forbidden')
    expect(await archivedAtOf(db, 'project-a')).not.toBeNull()
  })
})

describe('deleteProjectContainer', () => {
  let db: Kysely<DB>
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('creator deletes an empty project', async () => {
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OWNER.id,
    )
    expect(result).toBe('ok')
    expect(await containerExists(db, 'project-empty')).toBe(false)
  })

  test('a project that still holds a shareable cannot be deleted', async () => {
    const result = await deleteProjectContainer(db, WS, 'project-a', OWNER.id)
    expect(result).toBe('not-empty')
    expect(await containerExists(db, 'project-a')).toBe(true)
  })

  test('a project holding only a shareable hidden from the actor is not empty', async () => {
    // Admin cannot see u-other's private file via viewer scope, but deletion
    // must still count it. project-hidden holds one private file owned by other.
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-hidden',
      ADMIN.id,
    )
    expect(result).toBe('not-empty')
    expect(await containerExists(db, 'project-hidden')).toBe(true)
  })

  test('a non-creator non-admin cannot delete', async () => {
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OTHER.id,
    )
    expect(result).toBe('forbidden')
    expect(await containerExists(db, 'project-empty')).toBe(true)
  })

  test('deleting an empty project cascades its share defaults', async () => {
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'psd-1',
        project_container_id: 'project-empty',
        email: 'reviewer@partner.example',
        role: 'viewer',
        display_name: null,
        created_by_id: OWNER.id,
        created_at: TS,
        updated_at: TS,
      })
      .execute()

    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OWNER.id,
    )
    expect(result).toBe('ok')
    const defaults = await db
      .selectFrom('project_share_defaults')
      .select('id')
      .where('project_container_id', '=', 'project-empty')
      .execute()
    expect(defaults).toEqual([])
  })

  test('an archived empty project can be deleted', async () => {
    await archiveProjectContainer(db, WS, 'project-empty', OWNER.id)
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OWNER.id,
    )
    expect(result).toBe('ok')
    expect(await containerExists(db, 'project-empty')).toBe(false)
  })
})

describe('deleteProjectContainer with agent CLI credentials', () => {
  let db: Kysely<DB>
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
    await db
      .insertInto('agent_profiles')
      .values({
        id: 'agent-1',
        user_id: OWNER.id,
        workspace_id: WS,
        created_at: TS,
      })
      .execute()
  })
  afterEach(async () => {
    await db.destroy()
  })

  const PAST = '2020-01-01T00:00:00.000Z'
  const FUTURE = '2099-01-01T00:00:00.000Z'

  async function seedFamily(options: {
    credentialExpiresAt: string
    revokedAt?: string | null
    sessionExpiresAt?: string
  }) {
    await db
      .insertInto('cli_family_authorities')
      .values({
        family_id: 'family-1',
        user_id: OWNER.id,
        preset: 'agent',
        workspace_id: WS,
        project_id: 'project-empty',
        project_name_snapshot: 'project-empty',
        agent_profile_id: 'agent-1',
        approved_at: TS,
        device_name: 'Laptop',
        status: 'active',
        created_at: TS,
        updated_at: TS,
      })
      .execute()
    await db
      .insertInto('cli_refresh_credentials')
      .values({
        id: 'cred-1',
        user_id: OWNER.id,
        token_hash: 'hash-1',
        expires_at: options.credentialExpiresAt,
        revoked_at: options.revokedAt ?? null,
        created_at: TS,
        family_id: 'family-1',
      })
      .execute()
    if (options.sessionExpiresAt) {
      await db
        .insertInto('sessions')
        .values({
          id: 'sess-1',
          user_id: OWNER.id,
          token: 'tok-1',
          expires_at: options.sessionExpiresAt,
          created_at: TS,
          updated_at: TS,
        })
        .execute()
      await db
        .insertInto('cli_refresh_sessions')
        .values({
          session_id: 'sess-1',
          credential_id: 'cred-1',
          family_id: 'family-1',
        })
        .execute()
      await db
        .insertInto('cli_session_authorities')
        .values({
          session_id: 'sess-1',
          family_id: 'family-1',
          kind: 'family',
          preset: 'agent',
          expires_at: null,
          bearer_only: 1,
          created_at: TS,
        })
        .execute()
    }
  }

  async function seedBootstrap(options: {
    authorityExpiresAt: string
    sessionExpiresAt: string
  }) {
    await db
      .insertInto('sessions')
      .values({
        id: 'sess-boot',
        user_id: OWNER.id,
        token: 'tok-boot',
        expires_at: options.sessionExpiresAt,
        created_at: TS,
        updated_at: TS,
      })
      .execute()
    await db
      .insertInto('cli_session_authorities')
      .values({
        session_id: 'sess-boot',
        family_id: null,
        kind: 'bootstrap',
        preset: 'agent',
        workspace_id: WS,
        project_id: 'project-empty',
        agent_profile_id: 'agent-1',
        expires_at: options.authorityExpiresAt,
        bearer_only: 1,
        created_at: TS,
      })
      .execute()
  }

  test('an expired credential with no live session no longer blocks deletion', async () => {
    await seedFamily({ credentialExpiresAt: PAST })
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OWNER.id,
    )
    expect(result).toBe('ok')
    expect(await containerExists(db, 'project-empty')).toBe(false)
    // The authority row survives detached, keeping its name snapshot.
    const family = await db
      .selectFrom('cli_family_authorities')
      .select(['project_id', 'project_name_snapshot'])
      .where('family_id', '=', 'family-1')
      .executeTakeFirstOrThrow()
    expect(family.project_id).toBeNull()
    expect(family.project_name_snapshot).toBe('project-empty')
  })

  test('a revoked credential with no live session no longer blocks deletion', async () => {
    await seedFamily({ credentialExpiresAt: FUTURE, revokedAt: TS })
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OWNER.id,
    )
    expect(result).toBe('ok')
    expect(await containerExists(db, 'project-empty')).toBe(false)
  })

  test('an expired credential with a live linked session blocks deletion', async () => {
    await seedFamily({ credentialExpiresAt: PAST, sessionExpiresAt: FUTURE })
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OWNER.id,
    )
    expect(result).toEqual({
      kind: 'has-agent-credentials',
      holderName: OWNER.id,
    })
    expect(await containerExists(db, 'project-empty')).toBe(true)
  })

  test('a live credential blocks deletion with the holder name', async () => {
    await seedFamily({ credentialExpiresAt: FUTURE })
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OWNER.id,
    )
    expect(result).toEqual({
      kind: 'has-agent-credentials',
      holderName: OWNER.id,
    })
    expect(await containerExists(db, 'project-empty')).toBe(true)
  })

  test('an unexpired bootstrap authority on an expired session no longer blocks deletion', async () => {
    await seedBootstrap({ authorityExpiresAt: FUTURE, sessionExpiresAt: PAST })
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OWNER.id,
    )
    expect(result).toBe('ok')
    expect(await containerExists(db, 'project-empty')).toBe(false)
    const authority = await db
      .selectFrom('cli_session_authorities')
      .select('project_id')
      .where('session_id', '=', 'sess-boot')
      .executeTakeFirstOrThrow()
    expect(authority.project_id).toBeNull()
  })

  test('a live bootstrap authority blocks deletion', async () => {
    await seedBootstrap({
      authorityExpiresAt: FUTURE,
      sessionExpiresAt: FUTURE,
    })
    const result = await deleteProjectContainer(
      db,
      WS,
      'project-empty',
      OWNER.id,
    )
    expect(result).toEqual({
      kind: 'has-agent-credentials',
      holderName: OWNER.id,
    })
    expect(await containerExists(db, 'project-empty')).toBe(true)
  })

  test('a not-empty project reports not-empty even when credentials also block', async () => {
    await db
      .insertInto('cli_family_authorities')
      .values({
        family_id: 'family-a',
        user_id: OWNER.id,
        preset: 'agent',
        workspace_id: WS,
        project_id: 'project-a',
        project_name_snapshot: 'project-a',
        agent_profile_id: 'agent-1',
        approved_at: TS,
        device_name: 'Laptop',
        status: 'active',
        created_at: TS,
        updated_at: TS,
      })
      .execute()
    await db
      .insertInto('cli_refresh_credentials')
      .values({
        id: 'cred-a',
        user_id: OWNER.id,
        token_hash: 'hash-a',
        expires_at: FUTURE,
        created_at: TS,
        family_id: 'family-a',
      })
      .execute()
    const result = await deleteProjectContainer(db, WS, 'project-a', OWNER.id)
    expect(result).toBe('not-empty')
  })
})

describe('listArchivedWorkspaceProjects', () => {
  let db: Kysely<DB>
  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })
  afterEach(async () => {
    await db.destroy()
  })

  test('returns only archived projects in this workspace', async () => {
    await archiveProjectContainer(db, WS, 'project-a', OWNER.id)
    const archived = await listArchivedWorkspaceProjects(db, WS, OWNER)
    const ids = archived.map((p) => p.id)
    expect(ids).toContain('project-a')
    expect(ids).not.toContain('project-empty') // still active
    expect(ids).not.toContain('project-b') // other workspace
    expect(
      archived.find((p) => p.id === 'project-a')?.archivedAt,
    ).not.toBeNull()
  })
})

async function containerOf(db: Kysely<DB>, shareableId: string) {
  const row = await db
    .selectFrom('shareables')
    .select('container_id')
    .where('id', '=', shareableId)
    .executeTakeFirstOrThrow()
  return row.container_id
}

async function archivedAtOf(db: Kysely<DB>, projectId: string) {
  const row = await db
    .selectFrom('artifact_containers')
    .select('archived_at')
    .where('id', '=', projectId)
    .executeTakeFirstOrThrow()
  return row.archived_at
}

async function containerExists(db: Kysely<DB>, projectId: string) {
  const row = await db
    .selectFrom('artifact_containers')
    .select('id')
    .where('id', '=', projectId)
    .executeTakeFirst()
  return Boolean(row)
}

async function seed(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values([
      workspace('ws-a', 'example.com'),
      workspace('ws-b', 'other.example'),
    ])
    .execute()
  await db
    .insertInto('users')
    .values([
      user('u-owner', 'owner@example.com', 'ws-a'),
      user('u-other', 'other@example.com', 'ws-a'),
      user('u-admin', 'admin@example.com', 'ws-a'),
    ])
    .execute()
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
  await db
    .insertInto('artifact_containers')
    .values([
      project('project-a', 'ws-a', 'u-owner'),
      project('project-empty', 'ws-a', 'u-owner'),
      project('project-hidden', 'ws-a', 'u-owner'),
      project('project-b', 'ws-b', 'u-owner'),
    ])
    .execute()
  await db
    .insertInto('shareables')
    .values([
      shareable('s1', 'ws-a', 'u-owner', 'project-a', 'workspace'),
      shareable('s-hidden', 'ws-a', 'u-other', 'project-hidden', 'private'),
    ])
    .execute()
}

function workspace(id: string, hd: string) {
  return {
    id,
    hd,
    name: id,
    created_at: TS,
    plan: 'team' as const,
    storage_quota_bytes: 104857600,
    storage_used_bytes: 0,
    storage_updated_at: TS,
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

function project(id: string, workspaceId: string, createdById: string) {
  return {
    id,
    workspace_id: workspaceId,
    kind: 'project' as const,
    owner_user_id: null,
    created_by_id: createdById,
    name: id,
    description: null,
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
  visibility: 'private' | 'workspace',
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
