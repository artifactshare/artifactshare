import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

test('retention migration backfills created_at/id order, excludes failed uploads, and never reuses numbers', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    const index = migrations.findIndex(
      (m) => m.name === '0110_version_retention.sql',
    )
    expect(index).toBeGreaterThan(0)
    applyMigrations(sqlite, migrations.slice(0, index))
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'Workspace', '2026-09-01');
      INSERT INTO users (id, email, name, created_at, updated_at, workspace_id, google_sub)
        VALUES ('u1', 'author@example.com', 'Author', '2026-09-01', '2026-09-01', 'ws1', 'sub-1');
      INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at)
        VALUES ('c1', 'ws1', 'inbox', 'u1', 'u1', 'Home', '2026-09-01', '2026-09-01');
      INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id)
        VALUES ('s1', 'ws1', 'u1', 'Report', 'html_page', 'private', '2026-09-01', '2026-09-01', 'c1');
    `)
    const insert =
      sqlite.prepare(`INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
      VALUES (?, 's1', 'html_page', ?, '/index.html', ?, 12, 'hash', 'u1', ?, ?)`)
    // Creation order wins even when publication finishes later.
    insert.run('v3', 'published', 'key3', '2026-09-01', '2026-09-03')
    // Tied timestamps use id order, regardless of insertion order.
    insert.run('v2', 'published', 'key2', '2026-09-02', '2026-09-02')
    insert.run('v1', 'published', 'key1', '2026-09-02', '2026-09-02')
    insert.run('failed', 'failed', 'failed-key', '2026-09-01', null)
    insert.run('pending', 'uploading', 'pending-key', '2026-09-01', null)
    sqlite.exec("UPDATE shareables SET current_version_id = 'v3'")
    sqlite.exec(migrations[index]!.sql)
    expect(
      sqlite.prepare('SELECT id, number FROM versions ORDER BY id').all(),
    ).toEqual([
      { id: 'failed', number: null },
      { id: 'pending', number: null },
      { id: 'v1', number: 2 },
      { id: 'v2', number: 3 },
      { id: 'v3', number: 1 },
    ])
    expect(
      sqlite
        .prepare(
          'SELECT retain_versions, version_sequence, current_version_id FROM shareables',
        )
        .get(),
    ).toEqual({
      retain_versions: null,
      version_sequence: 3,
      current_version_id: 'v3',
    })
    const update = sqlite.prepare('UPDATE shareables SET retain_versions = ?')
    for (const invalid of [0, -1, 1.5, 'invalid'])
      expect(() => update.run(invalid)).toThrow(/CHECK/)
    update.run(1)
    update.run(null)
    sqlite.exec(
      "DELETE FROM versions WHERE id IN ('v1', 'v2'); UPDATE versions SET status = 'published', published_at = '2026-09-04' WHERE id = 'pending'",
    )
    expect(
      sqlite.prepare("SELECT number FROM versions WHERE id = 'pending'").get(),
    ).toEqual({ number: 4 })
    sqlite.exec(
      "UPDATE versions SET published_at = '2026-09-05' WHERE id = 'pending'",
    )
    insert.run('v5', 'published', 'key5', '2026-09-05', '2026-09-05')
    expect(
      sqlite.prepare("SELECT number FROM versions WHERE id = 'v5'").get(),
    ).toEqual({ number: 5 })
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    sqlite.close()
  }
})
