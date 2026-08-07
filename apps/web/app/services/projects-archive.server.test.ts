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
