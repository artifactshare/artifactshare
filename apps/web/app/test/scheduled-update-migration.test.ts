import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

test('activity backfills and mirrors metadata but excludes publisher pointer transitions, even with recursive triggers', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    const index = migrations.findIndex(
      (entry) => entry.name === '0115_publisher_version_activity.sql',
    )
    applyMigrations(sqlite, migrations.slice(0, index))
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'Workspace', '2026-01-01');
      INSERT INTO users (id, google_sub, email, workspace_id, created_at, updated_at) VALUES ('u1', 'sub-u1', 'owner@example.test', 'ws1', '2026-01-01', '2026-01-01');
      INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, name, created_at, updated_at) VALUES ('p1', 'ws1', 'inbox', 'u1', 'Home', '2026-01-01', '2026-01-01');
      INSERT INTO publisher_clients (id, user_id, workspace_id, name, created_at) VALUES ('client1', 'u1', 'ws1', 'Reports', '2026-01-01');
      INSERT INTO shareables (id, workspace_id, owner_user_id, container_id, name, artifact_kind, visibility, created_at, updated_at) VALUES ('abc123def4', 'ws1', 'u1', 'p1', 'Report', 'html_page', 'private', '2026-01-01', '2026-02-01');
    `)
    sqlite.exec(migrations[index]!.sql)
    const row = () =>
      sqlite
        .prepare('SELECT activity_at, updated_at FROM shareables WHERE id = ?')
        .get('abc123def4')
    expect(row()).toEqual({
      activity_at: '2026-02-01',
      updated_at: '2026-02-01',
    })
    sqlite.exec('PRAGMA recursive_triggers = ON')
    for (const [id, number, client] of [
      ['machine1', 1, 'client1'],
      ['machine2', 2, 'client1'],
      ['human3', 3, null],
    ] as const) {
      sqlite
        .prepare(
          `INSERT INTO versions (id, number, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_by_publisher_client_id, created_at, published_at) VALUES (?, ?, 'abc123def4', 'html_page', 'published', '/index.html', ?, 10, 'test', 'u1', ?, '2026-03-01', '2026-03-01')`,
        )
        .run(id, number, id, client)
    }
    const point = (id: string, time: string) =>
      sqlite
        .prepare(
          'UPDATE shareables SET current_version_id = ?, updated_at = ? WHERE id = ?',
        )
        .run(id, time, 'abc123def4')
    point('machine1', '2026-03-01')
    expect(row()).toEqual({
      activity_at: '2026-02-01',
      updated_at: '2026-03-01',
    })
    point('machine2', '2026-03-01')
    expect(row()).toEqual({
      activity_at: '2026-02-01',
      updated_at: '2026-03-01',
    })
    point('human3', '2026-03-01')
    expect(row()).toEqual({
      activity_at: '2026-03-01',
      updated_at: '2026-03-01',
    })
    point('machine2', '2026-04-01')
    sqlite.exec(
      "UPDATE shareables SET name = 'Renamed', updated_at = '2026-05-01' WHERE id = 'abc123def4'",
    )
    expect(row()).toEqual({
      activity_at: '2026-05-01',
      updated_at: '2026-05-01',
    })
    sqlite.exec(
      "INSERT INTO shareables (id, workspace_id, owner_user_id, container_id, name, artifact_kind, visibility, created_at, updated_at) VALUES ('second', 'ws1', 'u1', 'p1', 'Second', 'html_page', 'private', '2026-01-01', '2026-06-01')",
    )
    expect(
      sqlite
        .prepare("SELECT activity_at FROM shareables WHERE id = 'second'")
        .get(),
    ).toEqual({ activity_at: '2026-06-01' })
    sqlite.exec(
      "UPDATE shareables SET current_version_id = 'machine1', updated_at = '2026-07-01' WHERE id = 'second'",
    )
    expect(
      sqlite
        .prepare("SELECT activity_at FROM shareables WHERE id = 'second'")
        .get(),
    ).toEqual({ activity_at: '2026-07-01' })
  } finally {
    sqlite.close()
  }
})
