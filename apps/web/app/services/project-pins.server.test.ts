import { sql } from 'kysely'
import { describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import {
  listProjectPins,
  pinShareable,
  unpinShareable,
} from './project-pins.server'

describe('project pins', () => {
  test('adds, unpins, reports duplicates, rejects outside-container shareables, and keeps the 20-pin limit', async () => {
    const { db } = createMigratedInMemoryDb()
    await db
      .insertInto('workspaces')
      .values({
        id: 'w1',
        name: 'W',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'u1',
        email: 'u@example.com',
        name: 'U',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w1',
        locale: null,
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values([
        {
          id: 'p1',
          workspace_id: 'w1',
          kind: 'project',
          owner_user_id: 'u1',
          created_by_id: 'u1',
          name: 'P',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
        {
          id: 'p2',
          workspace_id: 'w1',
          kind: 'project',
          owner_user_id: 'u1',
          created_by_id: 'u1',
          name: 'P2',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ])
      .execute()
    const rows = Array.from({ length: 21 }, (_, i) => ({
      id: `s${i}`,
      workspace_id: 'w1',
      owner_user_id: 'u1',
      name: `S${i}`,
      artifact_kind: 'markdown_page' as const,
      visibility: 'private' as const,
      container_id: 'p1',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }))
    await db.insertInto('shareables').values(rows).execute()
    expect(
      await pinShareable(db, {
        containerId: 'p1',
        shareableId: 's0',
        userId: 'u1',
      }),
    ).toBe('added')
    expect(
      await pinShareable(db, {
        containerId: 'p1',
        shareableId: 's0',
        userId: 'u1',
      }),
    ).toBe('already-existed')
    expect(
      await pinShareable(db, {
        containerId: 'p2',
        shareableId: 's0',
        userId: 'u1',
      }),
    ).toBe('not-added')
    for (let i = 1; i < 21; i++)
      await pinShareable(db, {
        containerId: 'p1',
        shareableId: `s${i}`,
        userId: 'u1',
      })
    expect(
      Number(
        (
          await db
            .selectFrom('project_pins')
            .select((eb) => eb.fn.countAll<number>().as('count'))
            .where('container_id', '=', 'p1')
            .executeTakeFirstOrThrow()
        ).count,
      ),
    ).toBe(20)
    expect(
      await pinShareable(db, {
        containerId: 'p1',
        shareableId: 's20',
        userId: 'u1',
      }),
    ).toBe('not-added')
    await unpinShareable(db, { containerId: 'p1', shareableId: 's0' })
    expect(
      await db
        .selectFrom('project_pins')
        .selectAll()
        .where('container_id', '=', 'p1')
        .where('shareable_id', '=', 's0')
        .execute(),
    ).toEqual([])
    await db.destroy()
  })

  test('list keeps one row per pin when two versions share published_at', async () => {
    const { db } = createMigratedInMemoryDb()
    await db
      .insertInto('workspaces')
      .values({
        id: 'w1',
        name: 'W',
        hd: null,
        ms_tenant_id: null,
        email_domain: null,
        created_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'u1',
        email: 'u@example.com',
        name: 'U',
        email_verified: 1,
        image: null,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        workspace_id: 'w1',
        locale: null,
      })
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'p1',
        workspace_id: 'w1',
        kind: 'project',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: 'P',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 's1',
        workspace_id: 'w1',
        owner_user_id: 'u1',
        name: 'A',
        artifact_kind: 'markdown_page',
        visibility: 'workspace',
        container_id: 'p1',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })
      .execute()
    for (const id of ['v1', 'v2']) {
      await db
        .insertInto('versions')
        .values({
          id,
          shareable_id: 's1',
          artifact_kind: 'markdown_page',
          status: 'published',
          entrypoint_path: '/index.md',
          r2_key: id,
          size_bytes: 1,
          sha256: id,
          created_by_id: 'u1',
          created_at: '2026-01-01T00:00:00Z',
          published_at: '2026-01-02T00:00:00Z',
        })
        .execute()
    }
    await pinShareable(db, {
      containerId: 'p1',
      shareableId: 's1',
      userId: 'u1',
    })
    const rows = await listProjectPins(db, 'p1', sql<boolean>`1 = 1`)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.latestVersionNumber).toBe(2)
  })
})
