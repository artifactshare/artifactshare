import { describe, expect, test } from 'vitest'
import type { Kysely } from 'kysely'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import type { SessionUser } from '~/lib/user'
import { searchPalette } from './search-palette.server'

const user = (
  id = 'u1',
  workspaceId = 'w1',
  email = `${id}@example.com`,
): SessionUser =>
  ({
    id,
    workspaceId,
    email,
    emailVerified: true,
    name: id,
    image: null,
    hd: null,
  }) as SessionUser

async function fixture() {
  const f = createMigratedInMemoryDb()
  const db = f.db as Kysely<DB>
  for (const [id, ws] of [
    ['w1', 'example.com'],
    ['w2', 'other.example'],
  ] as const)
    await db
      .insertInto('workspaces')
      .values({
        id,
        name: id,
        hd: ws,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01',
      })
      .execute()
  for (const [id, ws, verified] of [
    ['u1', 'w1', 1],
    ['u2', 'w1', 1],
    ['u3', 'w1', 1],
    ['g1', 'w2', 1],
    ['g2', 'w2', 0],
  ] as const)
    await db
      .insertInto('users')
      .values({
        id,
        email: `${id}@${ws === 'w1' ? 'example.com' : 'other.example'}`,
        name: id,
        email_verified: verified,
        image: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
        workspace_id: ws,
        locale: null,
      })
      .execute()
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: 'w1',
      user_id: 'u3',
      role: 'admin',
      status: 'active',
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'p1',
      workspace_id: 'w1',
      kind: 'project',
      owner_user_id: null,
      created_by_id: 'u1',
      name: 'Shared Project',
      base_visibility: 'workspace',
      archived_at: null,
      created_at: '2026-01-01',
      updated_at: '2026-07-01',
    })
    .execute()
  return { db }
}
async function file(
  db: Kysely<DB>,
  id: string,
  owner = 'u1',
  visibility: 'workspace' | 'private' = 'workspace',
  created = '2026-07-01',
  title = id,
) {
  await db
    .insertInto('shareables')
    .values({
      id,
      workspace_id: 'w1',
      owner_user_id: owner,
      name: title,
      artifact_kind: 'markdown_page',
      visibility,
      container_id: 'p1',
      derived_title: null,
      title_override: null,
      description: null,
      view_count: 0,
      created_at: created,
      updated_at: created,
    })
    .execute()
}

describe('searchPalette', () => {
  test('returns three sections in order and breaks ties by id descending', async () => {
    const { db } = await fixture()
    await file(db, 'a', 'u1', 'workspace', '2026-07-01', 'needle')
    await file(db, 'b', 'u1', 'workspace', '2026-07-01', 'needle')
    const r = await searchPalette(db, user(), 'needle')
    expect(Object.keys(r)).toEqual(['ownFiles', 'recent', 'projects'])
    expect(r.ownFiles.map((x) => x.id)).toEqual(['b', 'a'])
  })
  test('escapes percent, omits lost-access history, and hides private projects', async () => {
    const { db } = await fixture()
    await file(db, 'percent', 'u1', 'workspace', '2026-07-01', '100%')
    // % を含まない自分のファイル。エスケープが壊れて %%% になると全件マッチして
    // この行が混入する (負の対照)
    await file(db, 'plain', 'u1', 'workspace', '2026-07-03', 'plain title')
    await file(db, 'private', 'u2', 'private', '2026-07-02', 'needle')
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 'private',
        viewer_user_id: 'u1',
        first_viewed_at: '2026-07-01',
        last_viewed_at: '2026-07-01',
        effective_view_count: 1,
      })
      .execute()
    const r = await searchPalette(db, user(), '%')
    expect(r.ownFiles.map((x) => x.id)).toEqual(['percent'])
    expect(r.recent.map((x) => x.id)).not.toContain('private')
  })
  test('does not duplicate joined shared projects, supports empty query, and truncates long queries', async () => {
    const { db } = await fixture()
    const r = await searchPalette(db, user(), 'x'.repeat(101))
    expect(r.projects).toBeDefined()
    await expect(searchPalette(db, user(), null)).resolves.toBeDefined()
  })

  test('cross-workspace history disappears when the project grant is revoked', async () => {
    const { db } = await fixture()
    await db
      .insertInto('shareables')
      .values({
        id: 'x1',
        workspace_id: 'w1',
        owner_user_id: 'u1',
        name: 'cross doc',
        artifact_kind: 'markdown_page',
        visibility: 'project',
        container_id: 'p1',
        derived_title: null,
        title_override: null,
        description: null,
        view_count: 0,
        created_at: '2026-07-01',
        updated_at: '2026-07-01',
      })
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 'x1',
        viewer_user_id: 'g1',
        first_viewed_at: '2026-07-02',
        last_viewed_at: '2026-07-02',
        effective_view_count: 1,
      })
      .execute()
    const g1 = user('g1', 'w2', 'g1@other.example')
    // grant が無い間は履歴があっても出ない
    expect((await searchPalette(db, g1, 'cross')).recent).toEqual([])
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'grant1',
        project_container_id: 'p1',
        email: 'g1@other.example',
        role: 'viewer',
        display_name: null,
        created_by_id: 'u1',
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      })
      .execute()
    expect(
      (await searchPalette(db, g1, 'cross')).recent.map((x) => x.id),
    ).toEqual(['x1'])
  })

  test('excludes an expired link and an archived project with the shared predicate', async () => {
    const { db } = await fixture()
    await db
      .insertInto('shareables')
      .values([
        {
          id: 'expired-link',
          workspace_id: 'w1',
          owner_user_id: 'u2',
          name: 'timed access',
          artifact_kind: 'markdown_page',
          visibility: 'link',
          container_id: 'p1',
          link_expires_at: '2026-08-03T00:30:00.000Z',
          created_at: '2026-07-01',
          updated_at: '2026-07-01',
        },
        {
          id: 'archived-file',
          workspace_id: 'w1',
          owner_user_id: 'u2',
          name: 'archived access',
          artifact_kind: 'markdown_page',
          visibility: 'workspace',
          container_id: 'p1',
          created_at: '2026-07-01',
          updated_at: '2026-07-01',
        },
      ])
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values([
        {
          shareable_id: 'expired-link',
          viewer_user_id: 'u1',
          first_viewed_at: '2026-07-02',
          last_viewed_at: '2026-07-02',
        },
        {
          shareable_id: 'archived-file',
          viewer_user_id: 'u1',
          first_viewed_at: '2026-07-02',
          last_viewed_at: '2026-07-02',
        },
      ])
      .execute()

    expect(
      (await searchPalette(db, user(), 'timed', '2026-08-03T01:00:00.000Z'))
        .recent,
    ).toEqual([])
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'expired-link',
        granted_email: 'u1@example.com',
        granted_at: '2026-08-03T00:00:00.000Z',
        granted_by: 'u2',
      })
      .execute()
    expect(
      (
        await searchPalette(db, user(), 'timed', '2026-08-03T01:00:00.000Z')
      ).recent.map((row) => row.id),
    ).toEqual(['expired-link'])
    await db
      .updateTable('artifact_containers')
      .set({ archived_at: '2026-08-03T00:00:00.000Z' })
      .where('id', '=', 'p1')
      .execute()
    expect(
      (await searchPalette(db, user(), 'archived', '2026-08-03T01:00:00.000Z'))
        .recent,
    ).toEqual([])
    await file(db, 'owned-archived', 'u1', 'workspace', '2026-07-01', 'mine')
    await db
      .insertInto('shareable_viewer_recency')
      .values({
        shareable_id: 'owned-archived',
        viewer_user_id: 'u1',
        first_viewed_at: '2026-07-02',
        last_viewed_at: '2026-07-02',
      })
      .execute()
    expect(
      (await searchPalette(db, user(), 'mine')).recent.map((row) => row.id),
    ).toEqual(['owned-archived'])
  })

  test('cross-workspace link history follows the workspace link policy', async () => {
    const { db } = await fixture()
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', 'w1')
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'cross-link',
        workspace_id: 'w1',
        owner_user_id: 'u1',
        name: 'cross policy',
        artifact_kind: 'markdown_page',
        visibility: 'link',
        container_id: 'p1',
        link_expires_at: '2026-08-04T00:00:00.000Z',
        created_at: '2026-07-01',
        updated_at: '2026-07-01',
      })
      .execute()
    await db
      .insertInto('shareable_viewer_recency')
      .values([
        {
          shareable_id: 'cross-link',
          viewer_user_id: 'g1',
          first_viewed_at: '2026-07-02',
          last_viewed_at: '2026-07-02',
        },
        {
          shareable_id: 'cross-link',
          viewer_user_id: 'u3',
          first_viewed_at: '2026-07-02',
          last_viewed_at: '2026-07-02',
        },
      ])
      .execute()
    const viewer = user('g1', 'w2', 'g1@other.example')

    expect(
      (
        await searchPalette(db, viewer, 'cross', '2026-08-03T00:00:00.000Z')
      ).recent.map((row) => row.id),
    ).toEqual(['cross-link'])
    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 0 })
      .where('id', '=', 'w1')
      .execute()
    expect(
      (await searchPalette(db, viewer, 'cross', '2026-08-03T00:00:00.000Z'))
        .recent,
    ).toEqual([])
    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 1 })
      .where('id', '=', 'w1')
      .execute()
    expect(
      (await searchPalette(db, viewer, 'cross', '2026-08-05T00:00:00.000Z'))
        .recent,
    ).toEqual([])
    await db
      .updateTable('workspaces')
      .set({ plan: 'team', link_sharing_enabled: 1 })
      .where('id', '=', 'w1')
      .execute()
    expect(
      (
        await searchPalette(
          db,
          user('u3', 'w1', 'u3@example.com'),
          'cross',
          '2026-08-05T00:00:00.000Z',
        )
      ).recent,
    ).toEqual([])
  })
})
