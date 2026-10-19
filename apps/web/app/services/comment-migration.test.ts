import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { applyMigrations, loadMigrations } from '~/test/sqlite-fixture'

test('comment bounds backfill preserves legacy excess and counters follow author cascades', () => {
  const sqlite = new DatabaseSync(':memory:')
  try {
    const migrations = loadMigrations()
    const bounds = migrations.findIndex(
      (migration) => migration.name === '0117_comment_bounds.sql',
    )
    expect(bounds).toBeGreaterThan(0)
    applyMigrations(sqlite, migrations.slice(0, bounds))
    sqlite.exec(`
      INSERT INTO workspaces (id, name, created_at) VALUES ('ws', 'Synthetic', '2026-01-01T00:00:00.000Z');
      INSERT INTO users (id, email, email_verified, workspace_id, created_at, updated_at, google_sub) VALUES
        ('owner', 'owner@example.com', 1, 'ws', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'owner'),
        ('reviewer', 'reviewer@example.com', 1, 'ws', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'reviewer');
      INSERT INTO artifact_containers (id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at)
        VALUES ('inbox', 'ws', 'inbox', 'owner', 'owner', 'Inbox', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO shareables (id, workspace_id, owner_user_id, name, artifact_kind, visibility, container_id, created_at, updated_at)
        VALUES ('artifact', 'ws', 'owner', 'Synthetic', 'html_page', 'private', 'inbox', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO comment_threads (id, shareable_id, status, created_by_id, created_at, updated_at)
        VALUES ('legacy', 'artifact', 'open', 'owner', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      WITH RECURSIVE numbers(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM numbers WHERE n<500)
      INSERT INTO comment_messages (id, thread_id, body, created_by_id, created_at, updated_at)
        SELECT 'message-' || n, 'legacy', 'Synthetic', CASE WHEN n = 0 THEN 'owner' ELSE 'reviewer' END, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z' FROM numbers;
    `)
    sqlite.exec(migrations[bounds].sql)
    const counts = () =>
      sqlite
        .prepare(
          "SELECT message_count, (SELECT count(*) FROM comment_messages) AS actual FROM comment_threads WHERE id = 'legacy'",
        )
        .get()
    expect(counts()).toEqual({ message_count: 501, actual: 501 })
    expect(() =>
      sqlite.exec(
        "INSERT INTO comment_messages (id, thread_id, body, created_by_id, created_at, updated_at) VALUES ('extra', 'legacy', 'Extra', 'owner', '2026-01-01', '2026-01-01')",
      ),
    ).toThrow('comment_thread_capacity')
    sqlite.exec("DELETE FROM users WHERE id = 'reviewer'")
    expect(counts()).toEqual({ message_count: 1, actual: 1 })
    sqlite.exec(
      "INSERT INTO comment_messages (id, thread_id, body, created_by_id, created_at, updated_at) VALUES ('restored', 'legacy', 'Restored capacity', 'owner', '2026-01-02', '2026-01-02')",
    )
    expect(counts()).toEqual({ message_count: 2, actual: 2 })
  } finally {
    sqlite.close()
  }
})
