import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from './sqlite-fixture'

import { anchorSeedSql } from './comment-anchor-seed'

const versionSql = `INSERT INTO versions (id, shareable_id, artifact_kind, status, entrypoint_path, r2_key, size_bytes, sha256, created_by_id, created_at, published_at)
 VALUES (?, 's1', 'html_page', 'published', '/index.html', ?, 12, 'content-hash', 'u1', '2026-09-01', '2026-09-01')`

test('migration retains unknown legacy lineage and records atomic current-pointer transitions', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations(),
      at = migrations.findIndex(
        (m) => m.name === '0109_comment_anchor_positions.sql',
      )
    applyMigrations(sqlite, migrations.slice(0, at))
    sqlite.exec(anchorSeedSql)
    sqlite.prepare(versionSql).run('v1', 'v1')
    sqlite.exec(
      "UPDATE shareables SET current_version_id = 'v1' WHERE id = 's1'",
    )
    sqlite.exec(migrations[at]!.sql)
    const row = (id: string) =>
      sqlite
        .prepare(
          'SELECT previous_current_version_id, anchor_lineage_recorded FROM versions WHERE id = ?',
        )
        .get(id)
    expect(row('v1')).toEqual({
      previous_current_version_id: null,
      anchor_lineage_recorded: 0,
    })
    sqlite.prepare(versionSql).run('v2', 'v2')
    expect(row('v2')).toEqual({
      previous_current_version_id: null,
      anchor_lineage_recorded: -1,
    })
    sqlite.exec(
      "UPDATE shareables SET current_version_id = 'v2' WHERE id = 's1'",
    )
    expect(row('v2')).toEqual({
      previous_current_version_id: 'v1',
      anchor_lineage_recorded: 1,
    })
    sqlite.exec(
      "UPDATE shareables SET current_version_id = 'v1' WHERE id = 's1'",
    )
    expect(row('v1')).toEqual({
      previous_current_version_id: null,
      anchor_lineage_recorded: 0,
    })
    sqlite.prepare(versionSql).run('v3', 'v3')
    sqlite.exec(
      "UPDATE shareables SET current_version_id = 'v3' WHERE id = 's1'",
    )
    expect(row('v3')).toEqual({
      previous_current_version_id: 'v1',
      anchor_lineage_recorded: 1,
    })
    sqlite.exec('BEGIN')
    sqlite.prepare(versionSql).run('v4', 'v4')
    sqlite.exec(
      "UPDATE shareables SET current_version_id = 'v4' WHERE id = 's1'",
    )
    sqlite.exec('ROLLBACK')
    expect(row('v4')).toBeUndefined()
    expect(
      sqlite.prepare('SELECT current_version_id FROM shareables').get(),
    ).toEqual({ current_version_id: 'v3' })
    sqlite.exec("DELETE FROM versions WHERE id = 'v1'")
    expect(row('v3')).toEqual({
      previous_current_version_id: 'v1',
      anchor_lineage_recorded: 1,
    })
    expect(sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    sqlite.close()
  }
})

test('position keys and constraints cannot confuse missing results with proven absence', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    applyMigrations(sqlite)
    sqlite.exec(anchorSeedSql)
    sqlite.prepare(versionSql).run('v1', 'v1')
    sqlite.exec(`
      UPDATE shareables SET current_version_id = 'v1' WHERE id = 's1';
      INSERT INTO comment_threads (id,shareable_id,status,created_by_id,created_at,updated_at) VALUES ('t1','s1','open','u1','2026-09-01','2026-09-01');
      INSERT INTO comment_anchors (id,thread_id,version_id,target_path,quoted_text,prefix_text,suffix_text,text_start,text_end,created_at)
        VALUES ('a1','t1','v1','/index.html','world','','',0,5,'2026-09-01');
    `)
    const insert = sqlite.prepare(
      "INSERT INTO comment_anchor_positions VALUES ('a1','v1','/index.html','source-dom-v1',?,?,?)",
    )
    expect(() => insert.run(null, null, null)).toThrow(/CHECK/)
    expect(() => insert.run(0, 0, null)).toThrow(/CHECK/)
    insert.run(0, 5, null)
    expect(() => insert.run(null, null, 'deleted')).toThrow(/UNIQUE/)
    sqlite.exec("DELETE FROM comment_threads WHERE id = 't1'")
    expect(
      sqlite.prepare('SELECT * FROM comment_anchor_positions').all(),
    ).toEqual([])
  } finally {
    sqlite.close()
  }
})
