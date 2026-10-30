import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

test('locus migration preserves existing anchor selectors and adds nullable metadata', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    const index = migrations.findIndex(
      (m) => m.name === '0119_comment_anchor_locus.sql',
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
    sqlite.exec(`
      INSERT INTO comment_threads (id, shareable_id, status, created_by_id, created_at, updated_at)
        VALUES ('t1', 's1', 'open', 'u1', '2026-09-01', '2026-09-01');
      INSERT INTO comment_anchors (id, thread_id, version_id, target_path, quoted_text, prefix_text, suffix_text, text_start, text_end, created_at)
        VALUES ('a1', 't1', 'v1', '/index.html', 'quote', '', '', 0, 5, '2026-09-01');
    `)
    const before = sqlite.prepare('SELECT * FROM comment_anchors').get()
    sqlite.exec(migrations[index]!.sql)
    expect(sqlite.prepare('SELECT * FROM comment_anchors').get()).toEqual({
      ...before,
      locus_headings: null,
      locus_block_text: null,
    })
    sqlite
      .prepare(
        'UPDATE comment_anchors SET locus_headings = ?, locus_block_text = ?',
      )
      .run('["Teams","Training"]', 'quote')
    expect(
      sqlite
        .prepare('SELECT locus_headings, locus_block_text FROM comment_anchors')
        .get(),
    ).toEqual({
      locus_headings: '["Teams","Training"]',
      locus_block_text: 'quote',
    })
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    sqlite.close()
  }
})
