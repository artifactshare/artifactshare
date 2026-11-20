import { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import { applyMigrations } from '~/test/sqlite-fixture'

test.each(['schema', 'migrations'])(
  '%s feed survives outer UPSERT with fresh exact-ack identities and ready rotation',
  (source) => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      if (source === 'migrations') applyMigrations(sqlite)
      else
        sqlite.exec(
          readFileSync(
            new URL('../../../db/schema.sql', import.meta.url),
            'utf8',
          ),
        )
      sqlite.exec(`
      INSERT INTO workspaces(id,name,created_at) VALUES('ws','Workspace','now');
      INSERT INTO users(id,email,name,workspace_id,created_at,updated_at${source === 'migrations' ? ',google_sub' : ''})
        VALUES('user','fixture@example.test','Fixture','ws','now','now'${source === 'migrations' ? ",'fixture'" : ''});
      INSERT INTO artifact_containers(id,workspace_id,kind,owner_user_id,created_by_id,name,created_at,updated_at)
        VALUES('inbox','ws','inbox','user','user','Inbox','now','now');
    `)
      const upsert = sqlite.prepare(`
      INSERT INTO shareables(id,workspace_id,owner_user_id,name,container_id,artifact_kind,visibility,created_at,updated_at)
      VALUES('file','ws','user',?,'inbox','html_page','private','now','now')
      ON CONFLICT(id) DO UPDATE SET name=excluded.name
    `)
      const change = () =>
        sqlite.prepare('SELECT id,recorded_at FROM search_index_changes').get()!
      upsert.run('Original')
      const original = change().id
      sqlite.exec(
        "DELETE FROM search_index_ready; UPDATE search_index_changes SET recorded_at='old'",
      )
      upsert.run('Edited')
      const fresh = change().id
      expect(fresh).toBeGreaterThan(original as number)
      expect(change().recorded_at).not.toBe('old')
      expect(
        sqlite.prepare('SELECT workspace_id FROM search_index_ready').all(),
      ).toEqual([{ workspace_id: 'ws' }])
      sqlite.exec("UPDATE search_index_ready SET dispatched_at='keep'")
      upsert.run('Concurrent edit')
      const newest = change().id
      expect(newest).toBeGreaterThan(fresh as number)
      sqlite.prepare('DELETE FROM search_index_changes WHERE id=?').run(fresh)
      expect(change().id).toBe(newest)
      expect(
        sqlite.prepare('SELECT dispatched_at FROM search_index_ready').all(),
      ).toEqual([{ dispatched_at: 'keep' }])
      sqlite.prepare('DELETE FROM search_index_changes WHERE id=?').run(newest)
      upsert.run('After acknowledgement')
      expect(change().id).toBeGreaterThan(newest as number)
    } finally {
      sqlite.close()
    }
  },
)
