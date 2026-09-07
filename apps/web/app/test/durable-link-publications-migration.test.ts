import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import {
  applyMigrations,
  createMigratedInMemoryDb,
  loadMigrations,
} from './sqlite-fixture'

const migrationName = '0107_durable_link_publications.sql'

function seedWorkspace(sqlite: DatabaseSync) {
  sqlite.exec(`
    INSERT INTO workspaces (id, name, created_at)
    VALUES ('ws-a', 'Workspace', '2026-09-08T00:00:00.000Z');
  `)
  const hasGoogleSub = sqlite
    .prepare(
      "SELECT 1 FROM pragma_table_info('users') WHERE name = 'google_sub'",
    )
    .get()
  sqlite.exec(
    hasGoogleSub
      ? `
    INSERT INTO users (
      id, email, name, created_at, updated_at, workspace_id, google_sub
    ) VALUES (
      'owner-1', 'owner@example.com', 'Owner',
      '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z',
      'ws-a', 'owner-sub'
    );`
      : `
    INSERT INTO users (
      id, email, name, created_at, updated_at, workspace_id
    ) VALUES (
      'owner-1', 'owner@example.com', 'Owner',
      '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z',
      'ws-a'
    );`,
  )
  sqlite.exec(`
    INSERT INTO artifact_containers (
      id, workspace_id, kind, owner_user_id, created_by_id, name,
      created_at, updated_at
    ) VALUES (
      'inbox-1', 'ws-a', 'inbox', 'owner-1', 'owner-1', 'Inbox',
      '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z'
    );
  `)
}

function insertShareable(
  sqlite: DatabaseSync,
  id: string,
  visibility: 'private' | 'link',
  createdAt: string,
) {
  sqlite
    .prepare(`
      INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        created_at, updated_at, container_id
      ) VALUES (?, 'ws-a', 'owner-1', ?, 'html_page', ?, ?, ?, 'inbox-1')
    `)
    .run(id, `${id}.html`, visibility, createdAt, createdAt)
}

describe('durable link publications migration', () => {
  test('backfills greatest timestamps strictly inside one deterministic window', () => {
    const migrations = loadMigrations()
    const sqlite = new DatabaseSync(':memory:')
    applyMigrations(
      sqlite,
      migrations.filter((migration) => migration.name < migrationName),
    )
    seedWorkspace(sqlite)
    for (const id of ['maxed', 'boundary', 'inside', 'before'])
      insertShareable(sqlite, id, 'private', '2026-09-01T00:00:00.000Z')
    insertShareable(sqlite, 'created-link', 'link', '2026-09-07T12:00:00.001Z')
    const event = sqlite.prepare(`
      INSERT INTO events (
        id, workspace_id, type, shareable_id, actor_user_id, subject_id,
        payload, created_at
      ) VALUES (?, 'ws-a', 'visibility_changed', ?, 'owner-1', ?,
        '{"from":"private","to":"link"}', ?)
    `)
    event.run('ev-max-1', 'maxed', 'ev-max-1', '2026-09-07T13:00:00.000Z')
    event.run('ev-max-2', 'maxed', 'ev-max-2', '2026-09-08T01:00:00.000Z')
    event.run(
      'ev-boundary',
      'boundary',
      'ev-boundary',
      '2026-09-07T12:00:00.000Z',
    )
    event.run('ev-inside', 'inside', 'ev-inside', '2026-09-07T12:00:00.001Z')
    event.run('ev-before', 'before', 'ev-before', '2026-09-07T11:59:59.999Z')

    sqlite.function('strftime', { varargs: true }, (...args) => {
      expect(args).toEqual(['%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours'])
      return '2026-09-07T12:00:00.000Z'
    })
    const migration = migrations.find((item) => item.name === migrationName)
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    expect(
      sqlite
        .prepare(`
          SELECT shareable_id, latest_published_at
          FROM link_publications
          ORDER BY shareable_id
        `)
        .all(),
    ).toEqual([
      {
        shareable_id: 'created-link',
        latest_published_at: '2026-09-07T12:00:00.001Z',
      },
      {
        shareable_id: 'inside',
        latest_published_at: '2026-09-07T12:00:00.001Z',
      },
      {
        shareable_id: 'maxed',
        latest_published_at: '2026-09-08T01:00:00.000Z',
      },
    ])
  })

  test('retains deleted artifact history, cascades workspaces, and records fallback writes', () => {
    const { sqlite } = createMigratedInMemoryDb()
    expect(
      sqlite
        .prepare(`
          SELECT name, type FROM sqlite_master
          WHERE name IN (
            'link_publications_workspace_published',
            'link_publications_shareable_published',
            'link_publication_active_id_guard',
            'link_publication_consume_insert_attempt',
            'link_publication_consume_transition_attempt',
            'link_publication_consume_link_update_attempt',
            'link_publication_record_insert_without_attempt',
            'link_publication_record_transition_without_attempt'
          )
          ORDER BY name
        `)
        .all(),
    ).toHaveLength(8)
    const publicationForeignKeys = sqlite
      .prepare("PRAGMA foreign_key_list('link_publications')")
      .all() as Array<{ table: string; from: string; on_delete: string }>
    expect(publicationForeignKeys).toMatchObject([
      { table: 'workspaces', from: 'workspace_id', on_delete: 'CASCADE' },
    ])
    expect(
      publicationForeignKeys.some((foreignKey) =>
        foreignKey.table.includes('shareables'),
      ),
    ).toBe(false)
    seedWorkspace(sqlite)
    insertShareable(sqlite, 'created-link', 'link', '2026-09-08T00:00:00.000Z')
    insertShareable(
      sqlite,
      'transitioned',
      'private',
      '2026-09-08T00:00:00.000Z',
    )
    sqlite.exec(`
      UPDATE shareables
      SET visibility = 'link', updated_at = '2026-09-08T01:00:00.000Z'
      WHERE id = 'transitioned';
      DELETE FROM shareables WHERE id = 'created-link';
    `)
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM link_publications').get(),
    ).toEqual({ count: 2 })
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM link_publication_attempts')
        .get(),
    ).toEqual({ count: 0 })
    expect(() =>
      insertShareable(
        sqlite,
        'created-link',
        'private',
        '2026-09-08T02:00:00.000Z',
      ),
    ).toThrow('UNIQUE constraint failed: shareables.id')
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at)
      VALUES ('ws-cascade', 'Cascade', '2026-09-08T00:00:00.000Z');
      INSERT INTO link_publications (
        workspace_id, shareable_id, latest_published_at
      ) VALUES (
        'ws-cascade', 'deleted-shareable', '2026-09-08T00:00:00.000Z'
      );
      DELETE FROM workspaces WHERE id = 'ws-cascade';
    `)
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM link_publications WHERE workspace_id = 'ws-cascade'",
        )
        .get(),
    ).toEqual({ count: 0 })
  })
})
