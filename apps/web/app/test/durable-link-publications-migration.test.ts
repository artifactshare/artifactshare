import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import {
  applyMigrations,
  createMigratedInMemoryDb,
  loadMigrations,
} from './sqlite-fixture'
import { createD1BatchDbMock } from './d1-batch-mock'

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

function createReleaseASchema() {
  const migrations = loadMigrations()
  const sqlite = new DatabaseSync(':memory:')
  applyMigrations(
    sqlite,
    migrations.filter((migration) => migration.name < migrationName),
  )
  seedWorkspace(sqlite)
  return { migrations, sqlite }
}

function applyReleaseB(
  sqlite: DatabaseSync,
  migrations: ReturnType<typeof loadMigrations>,
) {
  const migration = migrations.find((item) => item.name === migrationName)
  expect(migration).toBeDefined()
  sqlite.exec(migration!.sql)
}

function createBatchDatabase(sqlite: DatabaseSync) {
  return createD1BatchDbMock({ sqlite: { current: sqlite } })
}

function aWorkerAttemptStatement(
  database: ReturnType<typeof createD1BatchDbMock>,
  shareableId: string,
  publishedAt: string,
) {
  return database
    .prepare(`
      INSERT INTO link_publication_attempts (
        workspace_id, shareable_id, published_at, window_start,
        daily_limit, limit_applies, consumed
      ) VALUES (
        'ws-a', ?, ?, '2026-09-07T00:00:00.000Z', 20, 0, 1
      )
    `)
    .bind(shareableId, publishedAt)
}

function visibilityEventStatement(
  database: ReturnType<typeof createD1BatchDbMock>,
  shareableId: string,
  from: 'private' | 'link',
  to: 'private' | 'link',
  changedAt: string,
) {
  return database
    .prepare(`
      INSERT INTO events (
        id, workspace_id, type, shareable_id, actor_user_id, subject_id,
        payload, created_at
      ) VALUES (?, 'ws-a', 'visibility_changed', ?, 'owner-1', ?, ?, ?)
    `)
    .bind(
      `event-${shareableId}`,
      shareableId,
      `event-${shareableId}`,
      JSON.stringify({ from, to }),
      changedAt,
    )
}

function requestedGrantAssertionStatement(
  database: ReturnType<typeof createD1BatchDbMock>,
  shareableId: string,
  requestedEmail: string,
) {
  return database
    .prepare(`
      WITH requested(granted_email) AS (VALUES (?))
      UPDATE link_publication_attempts
      SET requested_grants_present = NOT EXISTS (
        SELECT 1
        FROM requested
        WHERE NOT EXISTS (
          SELECT 1
          FROM shareable_grants AS grant_row
          WHERE grant_row.shareable_id = link_publication_attempts.shareable_id
            AND lower(grant_row.granted_email) = requested.granted_email
        )
      )
      WHERE workspace_id = 'ws-a' AND shareable_id = ?
    `)
    .bind(requestedEmail, shareableId)
}

function deleteAttemptStatement(
  database: ReturnType<typeof createD1BatchDbMock>,
  shareableId: string,
) {
  return database
    .prepare(`
      DELETE FROM link_publication_attempts
      WHERE workspace_id = 'ws-a' AND shareable_id = ?
    `)
    .bind(shareableId)
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

  test('records one private-to-link publication for a successful Release A grant batch', async () => {
    const { migrations, sqlite } = createReleaseASchema()
    insertShareable(
      sqlite,
      'a-worker-success',
      'private',
      '2026-09-08T00:00:00.000Z',
    )
    applyReleaseB(sqlite, migrations)
    const database = createBatchDatabase(sqlite)
    const publishedAt = '2026-09-08T01:00:00.000Z'

    await database.batch([
      aWorkerAttemptStatement(database, 'a-worker-success', publishedAt),
      visibilityEventStatement(
        database,
        'a-worker-success',
        'private',
        'link',
        publishedAt,
      ),
      database
        .prepare(`
          UPDATE shareables
          SET visibility = 'link', updated_at = ?
          WHERE id = 'a-worker-success'
        `)
        .bind(publishedAt),
      database
        .prepare(`
          INSERT OR IGNORE INTO shareable_grants (
            shareable_id, granted_email, granted_at, granted_by
          ) VALUES ('a-worker-success', ?, ?, 'owner-1')
        `)
        .bind('viewer@example.com', publishedAt),
      requestedGrantAssertionStatement(
        database,
        'a-worker-success',
        'viewer@example.com',
      ),
      deleteAttemptStatement(database, 'a-worker-success'),
    ])

    expect(
      sqlite
        .prepare(`
          SELECT visibility,
            (SELECT COUNT(*) FROM events
              WHERE shareable_id = shareables.id) AS events,
            (SELECT COUNT(*) FROM shareable_grants
              WHERE shareable_id = shareables.id) AS grants,
            (SELECT COUNT(*) FROM link_publications
              WHERE shareable_id = shareables.id) AS publications,
            (SELECT latest_published_at FROM link_publications
              WHERE shareable_id = shareables.id) AS latest_published_at,
            (SELECT COUNT(*) FROM link_publication_attempts
              WHERE shareable_id = shareables.id) AS attempts
          FROM shareables
          WHERE id = 'a-worker-success'
        `)
        .get(),
    ).toEqual({
      attempts: 0,
      events: 1,
      grants: 1,
      latest_published_at: publishedAt,
      publications: 1,
      visibility: 'link',
    })
  })

  test.each([
    ['private', 'link'],
    ['link', 'private'],
  ] as const)(
    'rolls back a failed Release A grant batch from %s to %s',
    async (initialVisibility, nextVisibility) => {
      const { migrations, sqlite } = createReleaseASchema()
      const id = `a-worker-failure-${initialVisibility}`
      insertShareable(sqlite, id, 'private', '2026-09-08T00:00:00.000Z')
      sqlite
        .prepare(`
          INSERT INTO shareable_grants (
            shareable_id, granted_email, granted_at, granted_by
          ) VALUES (?, 'kept@example.com', '2026-09-08T00:00:00.000Z', 'owner-1')
        `)
        .run(id)
      applyReleaseB(sqlite, migrations)
      if (initialVisibility === 'link') {
        sqlite
          .prepare(`
            UPDATE shareables
            SET visibility = 'link', updated_at = '2026-09-08T00:30:00.000Z'
            WHERE id = ?
          `)
          .run(id)
      }
      const ledgerBefore = sqlite
        .prepare(`
          SELECT COUNT(*) AS count, MAX(latest_published_at) AS latest
          FROM link_publications WHERE shareable_id = ?
        `)
        .get(id)
      const database = createBatchDatabase(sqlite)
      const changedAt = '2026-09-08T01:00:00.000Z'

      await expect(
        database.batch([
          aWorkerAttemptStatement(database, id, changedAt),
          visibilityEventStatement(
            database,
            id,
            initialVisibility,
            nextVisibility,
            changedAt,
          ),
          database
            .prepare(`
              UPDATE shareables SET visibility = ?, updated_at = ?
              WHERE id = ?
            `)
            .bind(nextVisibility, changedAt, id),
          database
            .prepare(`
              DELETE FROM shareable_grants
              WHERE shareable_id = ? AND granted_email = 'kept@example.com'
            `)
            .bind(id),
          database
            .prepare(`
              INSERT INTO shareable_grants (
                shareable_id, granted_email, granted_at, granted_by
              ) VALUES (?, 'rolled-back@example.com', ?, 'owner-1')
            `)
            .bind(id, changedAt),
          requestedGrantAssertionStatement(database, id, 'missing@example.com'),
          deleteAttemptStatement(database, id),
        ]),
      ).rejects.toThrow(
        'CHECK constraint failed: link_publication_all_requested_grants_present',
      )

      expect(
        sqlite
          .prepare(`
            SELECT visibility,
              (SELECT COUNT(*) FROM events
                WHERE shareable_id = shareables.id) AS events,
              (SELECT COUNT(*) FROM shareable_grants
                WHERE shareable_id = shareables.id
                  AND granted_email = 'kept@example.com') AS kept_grants,
              (SELECT COUNT(*) FROM shareable_grants
                WHERE shareable_id = shareables.id
                  AND granted_email = 'rolled-back@example.com') AS new_grants,
              (SELECT COUNT(*) FROM link_publication_attempts
                WHERE shareable_id = shareables.id) AS attempts
            FROM shareables WHERE id = ?
          `)
          .get(id),
      ).toEqual({
        attempts: 0,
        events: 0,
        kept_grants: 1,
        new_grants: 0,
        visibility: initialVisibility,
      })
      expect(
        sqlite
          .prepare(`
            SELECT COUNT(*) AS count, MAX(latest_published_at) AS latest
            FROM link_publications WHERE shareable_id = ?
          `)
          .get(id),
      ).toEqual(ledgerBefore)
    },
  )

  test('rolls back a record-only fallback when a later statement fails', async () => {
    const { migrations, sqlite } = createReleaseASchema()
    insertShareable(
      sqlite,
      'fallback-rollback',
      'private',
      '2026-09-08T00:00:00.000Z',
    )
    applyReleaseB(sqlite, migrations)
    const database = createBatchDatabase(sqlite)

    await expect(
      database.batch([
        database
          .prepare(`
            UPDATE shareables
            SET visibility = 'link', updated_at = '2026-09-08T02:00:00.000Z'
            WHERE id = 'fallback-rollback'
          `)
          .bind(),
        database
          .prepare(`
            INSERT INTO link_publication_attempts (
              workspace_id, shareable_id, published_at, window_start,
              daily_limit, limit_applies
            ) VALUES (
              'ws-a', 'later-failure', '2026-09-08T02:00:00.000Z',
              '2026-09-07T02:00:00.000Z', -1, 0
            )
          `)
          .bind(),
      ]),
    ).rejects.toThrow('CHECK constraint failed: daily_limit >= 0')

    expect(
      sqlite
        .prepare(`
          SELECT visibility,
            (SELECT COUNT(*) FROM link_publications
              WHERE shareable_id = shareables.id) AS publications,
            (SELECT COUNT(*) FROM link_publication_attempts) AS attempts
          FROM shareables WHERE id = 'fallback-rollback'
        `)
        .get(),
    ).toEqual({ attempts: 0, publications: 0, visibility: 'private' })
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
