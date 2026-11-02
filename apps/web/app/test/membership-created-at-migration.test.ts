import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

const BACKFILLED_AT = '2026-07-12T13:56:49.411Z'

test('0120 restores the join time of memberships backfilled by 0060', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    const index = migrations.findIndex(
      (m) => m.name === '0120_backfill_membership_created_at.sql',
    )
    expect(index).toBeGreaterThan(0)
    applyMigrations(sqlite, migrations.slice(0, index))
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES
        ('ws1', 'Home', '2026-05-01T00:00:00.000Z'),
        ('ws2', 'Other', '2026-05-01T00:00:00.000Z');
      INSERT INTO users (id, email, name, created_at, updated_at, workspace_id, google_sub) VALUES
        ('early', 'early@example.com', 'Early', '2026-05-02T00:00:00.000Z', '2026-05-02T00:00:00.000Z', 'ws1', 'sub-early'),
        ('guest', 'guest@example.com', 'Guest', '2026-05-03T00:00:00.000Z', '2026-05-03T00:00:00.000Z', 'ws2', 'sub-guest'),
        ('rejoined', 'rejoined@example.com', 'Rejoined', '2026-05-04T00:00:00.000Z', '2026-05-04T00:00:00.000Z', 'ws1', 'sub-rejoined'),
        ('late', 'late@example.com', 'Late', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 'ws1', 'sub-late');
      INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at) VALUES
        ('ws1', 'early', 'owner', 'active', '${BACKFILLED_AT}', '2026-10-01T00:00:00.000Z'),
        ('ws1', 'guest', 'member', 'active', '${BACKFILLED_AT}', '${BACKFILLED_AT}'),
        ('ws1', 'rejoined', 'member', 'active', '2026-08-15T00:00:00.000Z', '2026-08-15T00:00:00.000Z'),
        ('ws1', 'late', 'member', 'active', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
    `)
    sqlite.exec(migrations[index]!.sql)
    const rows = sqlite
      .prepare(
        'SELECT user_id, created_at, updated_at FROM workspace_members ORDER BY user_id',
      )
      .all()
    expect(rows).toEqual([
      // Backfilled home membership: joined when the user was created.
      {
        user_id: 'early',
        created_at: '2026-05-02T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
      },
      // Not the user's home workspace: the creation time is not a join time.
      {
        user_id: 'guest',
        created_at: BACKFILLED_AT,
        updated_at: BACKFILLED_AT,
      },
      {
        user_id: 'late',
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
      },
      // Written by the application after 0060: kept as recorded.
      {
        user_id: 'rejoined',
        created_at: '2026-08-15T00:00:00.000Z',
        updated_at: '2026-08-15T00:00:00.000Z',
      },
    ])
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    sqlite.close()
  }
})
