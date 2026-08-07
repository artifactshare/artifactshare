import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

// moveShareableContainer / listMoveDestinations never touch the Workers env, but
// the module imports it at load time, so a bare env keeps the import resolvable.
vi.mock('cloudflare:workers', () => ({ env: {} }))

import {
  listMoveDestinations,
  moveShareableContainer,
} from './shareables.server'

const TS = '2026-06-03T00:00:00.000Z'
const OWNER = {
  id: 'u-owner',
  workspaceId: 'ws-a',
  email: 'owner@example.com',
  emailVerified: true,
}
const OTHER = {
  id: 'u-other',
  workspaceId: 'ws-a',
  email: 'other@example.com',
  emailVerified: true,
}
const ADMIN = { id: 'u-admin', workspaceId: 'ws-a', email: 'admin@example.com' }

describe('moveShareableContainer', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('owner moves a shareable from inbox into a project', async () => {
    const result = await moveShareableContainer(db, OWNER, 's1', {
      type: 'project',
      projectId: 'project-a',
    })
    expect(result).toMatchObject({ kind: 'ok', containerId: 'project-a' })
    expect(result).toMatchObject({
      visibility: 'private',
      projectAudienceMayChange: false,
    })
    expect(await containerOf(db, 's1')).toBe('project-a')
  })

  test('keeps pins when the destination project is invalid', async () => {
    await db
      .insertInto('project_pins')
      .values({
        container_id: 'inbox-owner',
        shareable_id: 's1',
        pinned_by_user_id: OWNER.id,
        created_at: TS,
      })
      .execute()
    const result = await moveShareableContainer(db, OWNER, 's1', {
      type: 'project',
      projectId: 'missing-project',
    })
    expect(result).toEqual({ kind: 'invalid-destination' })
    expect(
      await db
        .selectFrom('project_pins')
        .selectAll()
        .where('shareable_id', '=', 's1')
        .execute(),
    ).toHaveLength(1)
  })

  test('owner moves a shareable back into their own inbox', async () => {
    await moveShareableContainer(db, OWNER, 's1', {
      type: 'project',
      projectId: 'project-a',
    })
    const result = await moveShareableContainer(db, OWNER, 's1', {
      type: 'inbox',
    })
    expect(result).toMatchObject({ kind: 'ok', containerId: 'inbox-owner' })
    expect(await containerOf(db, 's1')).toBe('inbox-owner')
  })

  test('reports project audience changes for project-visible project moves', async () => {
    await db
      .updateTable('shareables')
      .set({ container_id: 'project-a', visibility: 'project' })
      .where('id', '=', 's1')
      .execute()

    const result = await moveShareableContainer(db, OWNER, 's1', {
      type: 'project',
      projectId: 'project-c',
    })

    expect(result).toMatchObject({
      kind: 'ok',
      containerId: 'project-c',
      visibility: 'project',
      projectAudienceMayChange: true,
    })
  })

  test('returns project-visible shareables to inbox as private', async () => {
    await db
      .updateTable('shareables')
      .set({ container_id: 'project-a', visibility: 'project' })
      .where('id', '=', 's1')
      .execute()

    const result = await moveShareableContainer(db, OWNER, 's1', {
      type: 'inbox',
    })

    expect(result).toMatchObject({
      kind: 'ok',
      containerId: 'inbox-owner',
      visibility: 'private',
      projectAudienceMayChange: false,
    })
  })

  test('a workspace admin may move another user shareable', async () => {
    const result = await moveShareableContainer(db, ADMIN, 's1', {
      type: 'project',
      projectId: 'project-a',
    })
    expect(result.kind).toBe('ok')
    expect(await containerOf(db, 's1')).toBe('project-a')
  })

  test('a non-owner non-admin cannot move it and existence stays hidden', async () => {
    const result = await moveShareableContainer(db, OTHER, 's1', {
      type: 'project',
      projectId: 'project-a',
    })
    expect(result).toEqual({ kind: 'not-found' })
    expect(await containerOf(db, 's1')).toBe('inbox-owner')
  })

  test('rejects an archived project as destination', async () => {
    const result = await moveShareableContainer(db, OWNER, 's1', {
      type: 'project',
      projectId: 'project-archived',
    })
    expect(result).toEqual({ kind: 'invalid-destination' })
    expect(await containerOf(db, 's1')).toBe('inbox-owner')
  })

  test('rejects a project in another workspace', async () => {
    const result = await moveShareableContainer(db, OWNER, 's1', {
      type: 'project',
      projectId: 'project-b',
    })
    expect(result).toEqual({ kind: 'invalid-destination' })
    expect(await containerOf(db, 's1')).toBe('inbox-owner')
  })

  test('does not apply the destination project share defaults', async () => {
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'psd-1',
        project_container_id: 'project-a',
        email: 'reviewer@partner.example',
        role: 'viewer',
        display_name: null,
        created_by_id: OWNER.id,
        created_at: TS,
        updated_at: TS,
      })
      .execute()

    await moveShareableContainer(db, OWNER, 's1', {
      type: 'project',
      projectId: 'project-a',
    })

    const grants = await db
      .selectFrom('shareable_grants')
      .select('granted_email')
      .where('shareable_id', '=', 's1')
      .execute()
    expect(grants).toEqual([])
  })

  test('does not add a workspace contributor', async () => {
    await moveShareableContainer(db, OWNER, 's1', {
      type: 'project',
      projectId: 'project-a',
    })
    const count = await db
      .selectFrom('workspace_members')
      .select((eb) => eb.fn.countAll<number>().as('total'))
      .where('status', '!=', 'removed')
      .where((eb) =>
        eb.or([
          eb('first_contributed_at', 'is not', null),
          eb('pending_uploads', '>', 0),
        ]),
      )
      .executeTakeFirstOrThrow()
    expect(Number(count.total)).toBe(0)
  })

  test('creates the owner inbox when none exists yet', async () => {
    await db
      .updateTable('shareables')
      .set({ container_id: 'project-a' })
      .where('id', '=', 's1')
      .execute()
    await db
      .deleteFrom('artifact_containers')
      .where('id', '=', 'inbox-owner')
      .execute()

    const result = await moveShareableContainer(db, OWNER, 's1', {
      type: 'inbox',
    })
    expect(result.kind).toBe('ok')
    const ownerInbox = await db
      .selectFrom('artifact_containers')
      .select('id')
      .where('workspace_id', '=', 'ws-a')
      .where('kind', '=', 'inbox')
      .where('owner_user_id', '=', OWNER.id)
      .executeTakeFirst()
    expect(ownerInbox).toBeDefined()
    expect(await containerOf(db, 's1')).toBe(ownerInbox?.id)
  })
})

describe('listMoveDestinations', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    ;({ db } = createMigratedInMemoryDb())
    await seed(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('flags the current inbox and excludes archived projects', async () => {
    const result = await listMoveDestinations(db, OWNER, 's1')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.inbox.isCurrent).toBe(true)
    const ids = result.projects.map((p) => p.containerId)
    expect(ids).toContain('project-a')
    expect(ids).not.toContain('project-archived')
    expect(ids).not.toContain('project-b')
  })

  test('marks a project the shareable already lives in as current', async () => {
    await moveShareableContainer(db, OWNER, 's1', {
      type: 'project',
      projectId: 'project-a',
    })
    const result = await listMoveDestinations(db, OWNER, 's1')
    if (result.kind !== 'ok') throw new Error('expected ok')
    expect(result.inbox.isCurrent).toBe(false)
    expect(
      result.projects.find((p) => p.containerId === 'project-a')?.isCurrent,
    ).toBe(true)
  })

  test('hides the shareable from a non-owner non-admin', async () => {
    const result = await listMoveDestinations(db, OTHER, 's1')
    expect(result).toEqual({ kind: 'not-found' })
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
      inbox('inbox-owner', 'ws-a', 'u-owner'),
      project('project-a', 'ws-a', null),
      project('project-c', 'ws-a', null),
      project('project-archived', 'ws-a', TS),
      project('project-b', 'ws-b', null),
    ])
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 's1',
      workspace_id: 'ws-a',
      owner_user_id: 'u-owner',
      slug: null,
      name: 'Weekly report',
      derived_title: null,
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'private',
      current_version_id: null,
      container_id: 'inbox-owner',
      created_at: TS,
      updated_at: TS,
      last_accessed_at: null,
    })
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

function inbox(id: string, workspaceId: string, ownerUserId: string) {
  return {
    id,
    workspace_id: workspaceId,
    kind: 'inbox' as const,
    owner_user_id: ownerUserId,
    created_by_id: ownerUserId,
    name: '未整理',
    description: null,
    archived_at: null,
    created_at: TS,
    updated_at: TS,
  }
}

function project(id: string, workspaceId: string, archivedAt: string | null) {
  return {
    id,
    workspace_id: workspaceId,
    kind: 'project' as const,
    owner_user_id: null,
    created_by_id: 'u-owner',
    name: id,
    description: null,
    archived_at: archivedAt,
    created_at: TS,
    updated_at: TS,
  }
}
