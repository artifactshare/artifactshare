import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

test('version labels migrate populated history without changing relationships or content', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    const index = migrations.findIndex(
      (m) => m.name === '0108_version_labels.sql',
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
      INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
        VALUES ('v1', 's1', 'html_page', 'published', '/index.html', 'artifacts/s1/v1/index.html', 12, 'content-hash', 'u1', '2026-09-01', '2026-09-01');
      UPDATE shareables SET current_version_id = 'v1' WHERE id = 's1';
    `)
    const before = sqlite.prepare('SELECT * FROM versions').get()
    sqlite.exec(migrations[index]!.sql)
    expect(sqlite.prepare('SELECT * FROM versions').get()).toEqual({
      ...before,
      label: null,
    })
    expect(
      sqlite.prepare('SELECT current_version_id FROM shareables').get(),
    ).toEqual({ current_version_id: 'v1' })
    const update = sqlite.prepare('UPDATE versions SET label = ? WHERE id = ?')
    for (const label of ['', 'a'.repeat(81)]) {
      expect(() => update.run(label, 'v1')).toThrow(/CHECK/)
    }
    update.run('😀'.repeat(80), 'v1')
    expect(sqlite.prepare('SELECT label FROM versions').get()).toEqual({
      label: '😀'.repeat(80),
    })
    update.run(null, 'v1')
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    sqlite.close()
  }
})
