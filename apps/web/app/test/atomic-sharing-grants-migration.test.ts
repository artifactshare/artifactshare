import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import {
  applyMigrations,
  createMigratedInMemoryDb,
  loadMigrations,
} from './sqlite-fixture'

const migrationName = '0106_atomic_sharing_grants.sql'

describe('atomic sharing grants migration', () => {
  test('is additive for old-shaped shareable and grant writes', () => {
    const migrations = loadMigrations()
    const sqlite = new DatabaseSync(':memory:')
    applyMigrations(
      sqlite,
      migrations.filter((migration) => migration.name < migrationName),
    )
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at)
      VALUES ('ws-a', 'Workspace', '2026-09-08T00:00:00.000Z');
      INSERT INTO users (
        id, email, name, created_at, updated_at, workspace_id, google_sub
      )
      VALUES (
        'owner-1',
        'owner@example.com',
        'Owner',
        '2026-09-08T00:00:00.000Z',
        '2026-09-08T00:00:00.000Z',
        'ws-a',
        'owner-sub'
      );
      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name,
        created_at, updated_at
      ) VALUES (
        'inbox-1', 'ws-a', 'inbox', 'owner-1', 'owner-1', 'Inbox',
        '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z'
      );
      INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        created_at, updated_at, container_id
      ) VALUES (
        'share-1', 'ws-a', 'owner-1', 'Document', 'html_page', 'private',
        '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z', 'inbox-1'
      );
    `)
    const migration = migrations.find((item) => item.name === migrationName)
    expect(migration).toBeDefined()
    sqlite.exec(migration!.sql)

    sqlite.exec(`
      UPDATE shareables
      SET visibility = 'link', updated_at = '2026-09-08T00:01:00.000Z'
      WHERE id = 'share-1';
      INSERT OR IGNORE INTO shareable_grants (
        shareable_id, granted_email, granted_at, granted_by
      ) VALUES (
        'share-1', 'viewer@example.com', '2026-09-08T00:01:00.000Z', 'owner-1'
      );
    `)

    expect(sqlite.prepare('SELECT visibility FROM shareables').get()).toEqual({
      visibility: 'link',
    })
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM shareable_grants').get(),
    ).toEqual({ count: 1 })
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM link_publication_attempts')
        .get(),
    ).toEqual({ count: 0 })
  })

  test('enforces the named requested-grant assertion', () => {
    const { sqlite } = createMigratedInMemoryDb()
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at)
      VALUES ('ws-a', 'Workspace', '2026-09-08T00:00:00.000Z');
      INSERT INTO link_publication_attempts (
        workspace_id, shareable_id, published_at, window_start,
        daily_limit, limit_applies, consumed
      ) VALUES (
        'ws-a', 'share-1', '2026-09-08T00:00:00.000Z',
        '2026-09-07T00:00:00.000Z', 20, 0, 1
      );
    `)

    expect(() =>
      sqlite.exec(`
        UPDATE link_publication_attempts
        SET requested_grants_present = 0
        WHERE workspace_id = 'ws-a' AND shareable_id = 'share-1'
      `),
    ).toThrow(
      'CHECK constraint failed: link_publication_all_requested_grants_present',
    )
  })

  test('refuses deletion until an attempt is consumed', () => {
    const { sqlite } = createMigratedInMemoryDb()
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at)
      VALUES ('ws-a', 'Workspace', '2026-09-08T00:00:00.000Z');
      INSERT INTO link_publication_attempts (
        workspace_id, shareable_id, published_at, window_start,
        daily_limit, limit_applies
      ) VALUES (
        'ws-a', 'share-1', '2026-09-08T00:00:00.000Z',
        '2026-09-07T00:00:00.000Z', 20, 0
      );
    `)

    expect(() =>
      sqlite.exec(`
        DELETE FROM link_publication_attempts
        WHERE workspace_id = 'ws-a' AND shareable_id = 'share-1'
      `),
    ).toThrow('link publication mutation missing')
    sqlite.exec(`
      UPDATE link_publication_attempts SET consumed = 1;
      DELETE FROM link_publication_attempts;
    `)
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM link_publication_attempts')
        .get(),
    ).toEqual({ count: 0 })
  })
})
