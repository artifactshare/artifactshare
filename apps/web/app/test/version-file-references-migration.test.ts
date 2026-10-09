import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

test('reference index preserves existing manifest rows and indexes shared keys', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    const index = migrations.findIndex(
      (m) => m.name === '0111_version_files_r2_key_index.sql',
    )
    expect(index).toBeGreaterThan(0)
    applyMigrations(sqlite, migrations.slice(0, index))
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES ('ws1', 'Workspace', '2026-09-01');
      INSERT INTO users (id, email, created_at, updated_at, workspace_id, google_sub) VALUES ('u1', 'author@example.com', '2026-09-01', '2026-09-01', 'ws1', 'sub-u1');
      INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, name, created_at, updated_at) VALUES ('c1', 'ws1', 'inbox', 'u1', 'Home', '2026-09-01', '2026-09-01');
      INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, created_at, updated_at, container_id) VALUES ('s1', 'ws1', 'u1', 'Site', 'static_site', 'private', '2026-09-01', '2026-09-01', 'c1');
      INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at) VALUES ('v1', 's1', 'static_site', 'published', '/index.html', 'index-key', 10, 'hash', 'u1', '2026-09-01', '2026-09-01');
      INSERT INTO version_files (id, version_id, path, r2_key, size_bytes, sha256, mime_type, created_at) VALUES ('f1', 'v1', '/index.html', 'index-key', 10, 'hash', 'text/html', '2026-09-01');
    `)
    const before = sqlite.prepare('SELECT * FROM version_files').all()
    sqlite.exec(migrations[index]!.sql)
    expect(sqlite.prepare('SELECT * FROM version_files').all()).toEqual(before)
    expect(
      sqlite.prepare("PRAGMA index_info('idx_version_files_r2_key')").all(),
    ).toEqual([expect.objectContaining({ name: 'r2_key' })])
    expect(
      sqlite
        .prepare(
          'EXPLAIN QUERY PLAN SELECT 1 FROM version_files WHERE r2_key = ?',
        )
        .all('index-key'),
    ).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining('idx_version_files_r2_key'),
      }),
    ])
  } finally {
    sqlite.close()
  }
})
