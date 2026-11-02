import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

const MIGRATION = '0120_backfill_membership_created_at.sql'
const BACKFILLED_AT = '2026-07-12T13:56:49.411Z'

function migratedBefore(name: string) {
  const sqlite = new DatabaseSync(':memory:')
  const migrations = loadMigrations()
  const index = migrations.findIndex((m) => m.name === name)
  expect(index).toBeGreaterThan(0)
  applyMigrations(sqlite, migrations.slice(0, index))
  return { sqlite, migrations, index }
}

function insertUsers(
  sqlite: DatabaseSync,
  users: Array<[id: string, createdAt: string, workspaceId: string]>,
) {
  const insert = sqlite.prepare(
    'INSERT INTO users (id, email, name, created_at, updated_at, workspace_id, google_sub) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  for (const [id, createdAt, workspaceId] of users)
    insert.run(
      id,
      `${id}@example.com`,
      id,
      createdAt,
      createdAt,
      workspaceId,
      `sub-${id}`,
    )
}

function insertMembers(
  sqlite: DatabaseSync,
  members: Array<[userId: string, workspaceId: string, createdAt: string]>,
) {
  const insert = sqlite.prepare(
    "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES (?, ?, 'member', 'active', ?, ?)",
  )
  for (const [userId, workspaceId, createdAt] of members)
    insert.run(workspaceId, userId, createdAt, createdAt)
}

function joinTimes(sqlite: DatabaseSync) {
  return Object.fromEntries(
    sqlite
      .prepare(
        'SELECT user_id, created_at FROM workspace_members ORDER BY user_id',
      )
      .all()
      .map((row) => [row.user_id, row.created_at]),
  )
}

test('0120 restores the join time of memberships backfilled by 0060', () => {
  const { sqlite, migrations, index } = migratedBefore(MIGRATION)
  try {
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES
        ('ws1', 'Team', '2026-05-01T00:00:00.000Z'),
        ('ws2', 'Personal', '2026-05-01T00:00:00.000Z');
    `)
    insertUsers(sqlite, [
      ['early', '2026-05-02T00:00:00.000Z', 'ws1'],
      ['second', '2026-05-03T00:00:00.000Z', 'ws2'],
      ['rejoined', '2026-05-04T00:00:00.000Z', 'ws1'],
      ['late', '2026-09-01T00:00:00.000Z', 'ws1'],
      // Removed from ws1 after the backfill and now homed in ws2.
      ['leaver', '2026-05-05T00:00:00.000Z', 'ws2'],
    ])
    sqlite
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES ('ws1', 'early', 'owner', 'active', ?, '2026-10-01T00:00:00.000Z')",
      )
      .run(BACKFILLED_AT)
    sqlite
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, status, removed_at, created_at, updated_at) VALUES ('ws1', 'leaver', 'member', 'removed', '2026-08-20T00:00:00.000Z', ?, '2026-08-20T00:00:00.000Z')",
      )
      .run(BACKFILLED_AT)
    insertMembers(sqlite, [
      ['second', 'ws2', BACKFILLED_AT],
      // Joined a non-home workspace later; never part of the backfill.
      ['second', 'ws1', '2026-08-01T00:00:00.000Z'],
      // Written by the application after 0060.
      ['rejoined', 'ws1', '2026-08-15T00:00:00.000Z'],
      ['late', 'ws1', '2026-09-01T00:00:00.000Z'],
    ])
    sqlite.exec(migrations[index]!.sql)
    expect(
      sqlite
        .prepare(
          'SELECT workspace_id, user_id, created_at, updated_at FROM workspace_members ORDER BY user_id, workspace_id',
        )
        .all(),
    ).toEqual([
      {
        workspace_id: 'ws1',
        user_id: 'early',
        created_at: '2026-05-02T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
      },
      {
        workspace_id: 'ws1',
        user_id: 'late',
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      },
      {
        workspace_id: 'ws1',
        user_id: 'leaver',
        created_at: BACKFILLED_AT,
        updated_at: '2026-08-20T00:00:00.000Z',
      },
      {
        workspace_id: 'ws1',
        user_id: 'rejoined',
        created_at: '2026-08-15T00:00:00.000Z',
        updated_at: '2026-08-15T00:00:00.000Z',
      },
      {
        workspace_id: 'ws1',
        user_id: 'second',
        created_at: '2026-08-01T00:00:00.000Z',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      {
        workspace_id: 'ws2',
        user_id: 'second',
        created_at: '2026-05-03T00:00:00.000Z',
        updated_at: BACKFILLED_AT,
      },
    ])
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    sqlite.close()
  }
})

test('0120 leaves application-written memberships unchanged when no backfilled row survives', () => {
  const { sqlite, migrations, index } = migratedBefore(MIGRATION)
  try {
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES
        ('ws1', 'Team', '2026-05-01T00:00:00.000Z');
    `)
    insertUsers(sqlite, [
      ['moved', '2026-05-02T00:00:00.000Z', 'ws1'],
      ['other', '2026-05-03T00:00:00.000Z', 'ws1'],
    ])
    // The only backfilled row was deleted when the user moved here on 2026-07-12.
    insertMembers(sqlite, [
      ['moved', 'ws1', '2026-07-12T20:00:00.000Z'],
      ['other', 'ws1', '2026-08-01T00:00:00.000Z'],
    ])
    sqlite.exec(migrations[index]!.sql)
    expect(joinTimes(sqlite)).toEqual({
      moved: '2026-07-12T20:00:00.000Z',
      other: '2026-08-01T00:00:00.000Z',
    })
  } finally {
    sqlite.close()
  }
})

test('0120 leaves rows from a 0060 run after its release date unchanged', () => {
  const { sqlite, migrations, index } = migratedBefore(
    '0060_workspace_members_audit_events.sql',
  )
  try {
    sqlite.exec(`
      INSERT INTO workspaces (id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes, storage_updated_at)
        VALUES ('ws1', 'example.com', 'Team', '2026-05-01T00:00:00.000Z', 'free', 104857600, 0, '1970-01-01T00:00:00.000Z');
      INSERT INTO users (id, email, email_verified, name, image, created_at, updated_at, workspace_id, google_sub, locale) VALUES
        ('a', 'a@example.com', 1, 'A', NULL, '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z', 'ws1', 'sub-a', NULL),
        ('b', 'b@example.com', 1, 'B', NULL, '2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z', 'ws1', 'sub-b', NULL);
    `)
    const end = migrations.findIndex((m) => m.name === MIGRATION)
    applyMigrations(sqlite, migrations.slice(index, end))
    const before = joinTimes(sqlite)
    // 0060 stamps the run time, which is after 2026-07-12 in this test run.
    expect(before.a).toBe(before.b)
    sqlite.exec(migrations[end]!.sql)
    expect(joinTimes(sqlite)).toEqual(before)
  } finally {
    sqlite.close()
  }
})
