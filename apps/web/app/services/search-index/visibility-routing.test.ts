import type { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { currentSchemaSources } from '~/test/sqlite-fixture'

function seed(sqlite: DatabaseSync, fileCount: number) {
  // The migrations keep users.google_sub NOT NULL; schema.sql has dropped it.
  const hasGoogleSub =
    sqlite
      .prepare("SELECT 1 FROM pragma_table_info('users') WHERE name = ?")
      .get('google_sub') !== undefined
  const user = (id: string, workspace: string) =>
    hasGoogleSub
      ? `('${id}','${id}@example.test','${id}','${workspace}','now','now','sub-${id}')`
      : `('${id}','${id}@example.test','${id}','${workspace}','now','now')`
  sqlite.exec(`
    INSERT INTO workspaces(id,name,created_at) VALUES('a','A','now'),('b','B','now');
    INSERT INTO users(id,email,name,workspace_id,created_at,updated_at${hasGoogleSub ? ',google_sub' : ''})
      VALUES${user('owner', 'a')},${user('other', 'b')};
    INSERT INTO artifact_containers(id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at)
      VALUES('project','a','project','Project','private','owner','now','now'),
            ('destination','b','project','Destination','private','other','now','now');
    WITH RECURSIVE n(x) AS (SELECT 0 UNION ALL SELECT x+1 FROM n WHERE x<${fileCount - 1})
    INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at)
    SELECT 'file-'||x,'a','owner','File','html_page','private','project','now','now' FROM n;
    DELETE FROM search_index_changes;
    DELETE FROM search_index_policy_changes;
    DELETE FROM search_index_ready;
  `)
}

describe.each(currentSchemaSources)(
  'search index ownership routing (%s)',
  (_name, create) => {
    let sqlite: DatabaseSync

    beforeEach(() => {
      sqlite = create()
    })

    afterEach(() => {
      sqlite.close()
    })

    const owners = () =>
      sqlite
        .prepare(
          'SELECT * FROM search_owner_workspaces ORDER BY actor_id,workspace_id',
        )
        .all()

    test('counts files per owner workspace and follows every move', () => {
      seed(sqlite, 3)
      expect(owners()).toEqual([
        { actor_id: 'owner', workspace_id: 'a', file_count: 3 },
      ])

      sqlite.exec(`INSERT INTO shareables(id,workspace_id,owner_user_id,name,artifact_kind,visibility,container_id,created_at,updated_at)
        VALUES('file-0','b','other','Moved','html_page','private','destination','now','now')
        ON CONFLICT(id) DO UPDATE SET workspace_id=excluded.workspace_id,owner_user_id=excluded.owner_user_id,container_id=excluded.container_id;`)
      expect(owners()).toEqual([
        { actor_id: 'other', workspace_id: 'b', file_count: 1 },
        { actor_id: 'owner', workspace_id: 'a', file_count: 2 },
      ])

      sqlite.exec(
        "DELETE FROM users WHERE id='owner'; DELETE FROM workspaces WHERE id='a'",
      )
      expect(owners()).toEqual([
        { actor_id: 'other', workspace_id: 'b', file_count: 1 },
      ])
      sqlite.exec("DELETE FROM shareables WHERE id='file-0'")
      expect(owners()).toEqual([])
      expect(() =>
        sqlite.exec(
          "INSERT INTO search_owner_workspaces VALUES('other','b',-1)",
        ),
      ).toThrow()
    })

    test('coalesces one policy key per container however many files it holds', () => {
      seed(sqlite, 3)
      sqlite.exec(
        "UPDATE artifact_containers SET base_visibility='workspace' WHERE id='project'",
      )
      const first = sqlite
        .prepare('SELECT id FROM search_index_policy_changes')
        .get() as { id: number }
      sqlite.exec(
        "INSERT INTO artifact_containers(id,workspace_id,kind,name,base_visibility,created_by_id,created_at,updated_at) VALUES('project','a','project','Renamed','private','other','now','now') ON CONFLICT(id) DO UPDATE SET name=excluded.name,created_by_id=excluded.created_by_id",
      )
      const second = sqlite
        .prepare('SELECT id FROM search_index_policy_changes')
        .get() as { id: number }
      expect(second.id).toBeGreaterThan(first.id)

      // The superseded id is gone, so a reader that acknowledged it still sees the change.
      sqlite
        .prepare('DELETE FROM search_index_policy_changes WHERE id=?')
        .run(first.id)
      expect(
        sqlite
          .prepare('SELECT kind,policy_key FROM search_index_policy_changes')
          .all(),
      ).toEqual([{ kind: 'container', policy_key: 'project' }])
      expect(
        sqlite.prepare('SELECT * FROM search_index_changes').all(),
      ).toEqual([])

      const before = owners()
      sqlite.exec(
        "BEGIN; UPDATE shareables SET owner_user_id='other' WHERE id='file-1'; UPDATE artifact_containers SET archived_at='now' WHERE id='project'; ROLLBACK;",
      )
      expect(owners()).toEqual(before)
      expect(
        (
          sqlite
            .prepare('SELECT id FROM search_index_policy_changes')
            .get() as {
            id: number
          }
        ).id,
      ).toBe(second.id)
    })

    test('leaves the policy and ready queues idle for harmless edits', () => {
      seed(sqlite, 1)
      sqlite.exec(`
        UPDATE workspaces SET storage_used_bytes=1,storage_quota_bytes=2048,name='Renamed' WHERE id='a';
        UPDATE artifact_containers SET name='Renamed',description='Description',updated_at='later' WHERE id='project';
        UPDATE workspaces SET link_sharing_enabled=link_sharing_enabled WHERE id='a';
        UPDATE artifact_containers SET base_visibility=base_visibility WHERE id='project';
      `)
      expect(
        sqlite.prepare('SELECT * FROM search_index_policy_changes').all(),
      ).toEqual([])
      expect(sqlite.prepare('SELECT * FROM search_index_ready').all()).toEqual(
        [],
      )

      sqlite.exec(
        "UPDATE artifact_containers SET base_visibility='workspace' WHERE id='project'; UPDATE workspaces SET link_sharing_enabled=1-link_sharing_enabled WHERE id='a';",
      )
      expect(
        sqlite
          .prepare(
            'SELECT kind,policy_key FROM search_index_policy_changes ORDER BY kind',
          )
          .all(),
      ).toEqual([
        { kind: 'container', policy_key: 'project' },
        { kind: 'workspace', policy_key: 'a' },
      ])
      expect(
        sqlite.prepare('SELECT workspace_id FROM search_index_ready').all(),
      ).toEqual([{ workspace_id: 'a' }])
    })
  },
)
