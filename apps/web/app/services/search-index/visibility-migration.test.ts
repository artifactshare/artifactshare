import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from '~/test/sqlite-fixture'

test('100,000-row ownership backfill, keyed UPSERT moves, rollback and cascade cleanup', () => {
  const db = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    applyMigrations(
      db,
      migrations.filter((m) => m.name < '0132_'),
    )
    db.exec(`
      INSERT INTO workspaces(id,name,created_at) VALUES('a','A','now'),('b','B','now');
      INSERT INTO users(id,email,google_sub,name,workspace_id,created_at,updated_at) VALUES('owner','owner@example.test','owner','Owner','a','now','now'),('other','other@example.test','other','Other','b','now','now');
      INSERT INTO artifact_containers(id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at) VALUES('project','a','project','Project','private','owner','now','now'),('destination','b','project','Destination','private','other','now','now');
      WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<99999)
      INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at)
      SELECT 'file-'||x,'a','owner','File','html_page','private','project','now','now' FROM n;
    `)
    applyMigrations(
      db,
      migrations.filter((m) => m.name.startsWith('0132_')),
    )
    const counts = () =>
      db
        .prepare(
          'SELECT * FROM search_owner_workspaces ORDER BY actor_id,workspace_id',
        )
        .all()
    expect(counts()).toEqual([
      { actor_id: 'owner', workspace_id: 'a', file_count: 100_000 },
    ])
    db.exec(`INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at)
      VALUES('file-0','b','other','Moved','html_page','private','destination','now','now')
      ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,owner_user_id=excluded.owner_user_id,container_id=excluded.container_id;`)
    expect(counts()).toEqual([
      { actor_id: 'other', workspace_id: 'b', file_count: 1 },
      { actor_id: 'owner', workspace_id: 'a', file_count: 99_999 },
    ])
    db.exec(
      'DELETE FROM search_index_changes; DELETE FROM search_index_policy_changes; DELETE FROM search_index_ready;',
    )
    // Every project-level mutation is one coalescing key regardless of its 99,999 children.
    db.exec(
      "UPDATE artifact_containers SET base_visibility='workspace' WHERE id='project'",
    )
    const first = db
      .prepare('SELECT id FROM search_index_policy_changes')
      .get()!.id
    db.exec(
      "INSERT INTO artifact_containers(id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at) VALUES('project','a','project','Renamed','private','other','now','now') ON CONFLICT(id) DO UPDATE SET name=excluded.name,created_by_id=excluded.created_by_id",
    )
    const second = db
      .prepare('SELECT id FROM search_index_policy_changes')
      .get()!.id
    expect(second).toBeGreaterThan(first as number)
    db.prepare('DELETE FROM search_index_policy_changes WHERE id=?').run(first)
    expect(
      db
        .prepare('SELECT kind,policy_key FROM search_index_policy_changes')
        .all(),
    ).toEqual([{ kind: 'container', policy_key: 'project' }])
    expect(db.prepare('SELECT * FROM search_index_changes').all()).toEqual([])
    const before = counts()
    db.exec(
      "BEGIN; UPDATE shareables SET owner_user_id='other' WHERE id='file-1'; UPDATE artifact_containers SET archived_at='now' WHERE id='project'; ROLLBACK;",
    )
    expect(counts()).toEqual(before)
    expect(
      db.prepare('SELECT id FROM search_index_policy_changes').get()!.id,
    ).toBe(second)
    db.exec(
      "DELETE FROM users WHERE id='owner'; DELETE FROM workspaces WHERE id='a'",
    )
    expect(counts()).toEqual([
      { actor_id: 'other', workspace_id: 'b', file_count: 1 },
    ])
    db.exec("DELETE FROM shareables WHERE id='file-0'")
    expect(counts()).toEqual([])
    expect(() =>
      db.exec("INSERT INTO search_owner_workspaces VALUES('other','b',-1)"),
    ).toThrow()
  } finally {
    db.close()
  }
})

test('harmless workspace and container updates leave policy and ready queues idle', () => {
  const db = new DatabaseSync(':memory:')
  try {
    applyMigrations(db, loadMigrations())
    db.exec(`
      INSERT INTO workspaces(id,name,created_at) VALUES('idle','Idle','now');
      INSERT INTO users(id,email,google_sub,name,workspace_id,created_at,updated_at) VALUES('idle-owner','idle@example.test','idle-owner','Owner','idle','now','now');
      INSERT INTO artifact_containers(id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at) VALUES('idle-project','idle','project','Project','private','idle-owner','now','now');
      DELETE FROM search_index_policy_changes;
      DELETE FROM search_index_ready;
      UPDATE workspaces SET storage_used_bytes=1,storage_quota_bytes=2048,name='Renamed' WHERE id='idle';
      UPDATE artifact_containers SET name='Renamed',description='Description',updated_at='later' WHERE id='idle-project';
      UPDATE workspaces SET link_sharing_enabled=link_sharing_enabled WHERE id='idle';
      UPDATE artifact_containers SET base_visibility=base_visibility WHERE id='idle-project';
    `)
    expect(
      db.prepare('SELECT * FROM search_index_policy_changes').all(),
    ).toEqual([])
    expect(db.prepare('SELECT * FROM search_index_ready').all()).toEqual([])
    db.exec(
      "UPDATE artifact_containers SET base_visibility='workspace' WHERE id='idle-project'; UPDATE workspaces SET link_sharing_enabled=1-link_sharing_enabled WHERE id='idle';",
    )
    expect(
      db
        .prepare(
          'SELECT kind,policy_key FROM search_index_policy_changes ORDER BY kind',
        )
        .all(),
    ).toEqual([
      { kind: 'container', policy_key: 'idle-project' },
      { kind: 'workspace', policy_key: 'idle' },
    ])
    expect(
      db.prepare('SELECT workspace_id FROM search_index_ready').all(),
    ).toEqual([{ workspace_id: 'idle' }])
  } finally {
    db.close()
  }
})
