import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let db: D1Database

beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  db = (await worker.getEnv()).DB
  await db.batch([
    db
      .prepare('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)')
      .bind('atomic-ws', 'Atomic', '2026-09-08T00:00:00.000Z'),
    db
      .prepare(
        `INSERT INTO users (
          id, email, email_verified, name, created_at, updated_at, workspace_id,
          google_sub, kind
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'human')`,
      )
      .bind(
        'atomic-owner',
        'atomic@example.com',
        'Owner',
        '2026-09-08T00:00:00.000Z',
        '2026-09-08T00:00:00.000Z',
        'atomic-ws',
        'atomic-owner-sub',
      ),
    db
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name,
          created_at, updated_at
        ) VALUES ('atomic-inbox', 'atomic-ws', 'inbox', 'atomic-owner',
          'atomic-owner', 'Inbox', ?, ?)`,
      )
      .bind('2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z'),
  ])
})

afterAll(async () => {
  await server.close()
})

async function seedShareable(id: string) {
  await db
    .prepare(
      `INSERT INTO shareables (
        id, workspace_id, owner_user_id, name, artifact_kind, visibility,
        created_at, updated_at, container_id
      ) VALUES (?, 'atomic-ws', 'atomic-owner', ?, 'html_page', 'link', ?, ?,
        'atomic-inbox')`,
    )
    .bind(id, id, '2026-09-08T00:00:00.000Z', '2026-09-08T00:00:00.000Z')
    .run()
}

function transitionBatch(shareableId: string, eventId: string) {
  const now = '2026-09-08T01:00:00.000Z'
  const payload = JSON.stringify({
    actor: { kind: 'operator_credential', credentialId: eventId },
    source: { kind: 'judgment', id: 'judgment-1' },
    reason: 'review',
    notify: true,
    recipients: [],
  })
  return db.batch([
    db
      .prepare(
        `INSERT INTO events (
          id, workspace_id, type, shareable_id, actor_user_id, subject_id,
          payload, created_at
        )
        SELECT ?, workspace_id, 'link_suspended', id, NULL, ?, ?, ?
        FROM shareables
        WHERE id = ? AND visibility = 'link' AND link_suspended_at IS NULL`,
      )
      .bind(eventId, `${eventId}-subject`, payload, now, shareableId),
    db
      .prepare(
        `INSERT INTO audit_events (
          id, workspace_id, actor_user_id, action, subject_type, subject_id,
          detail, created_at
        )
        SELECT ?, workspace_id, NULL, 'shareable.link.suspend', 'shareable',
          shareable_id, json_remove(payload, '$.recipients'), created_at
        FROM events WHERE id = ?`,
      )
      .bind(`${eventId}-audit`, eventId),
    db
      .prepare(
        `UPDATE shareables
         SET link_suspended_at = ?, link_suspended_reason = 'review'
         WHERE id = ?
           AND id IN (SELECT shareable_id FROM events WHERE id = ?)`,
      )
      .bind(now, shareableId, eventId),
  ])
}

describe.sequential('link suspension D1 atomicity', () => {
  it('commits exactly one event, audit, and flag update under concurrent transitions', async () => {
    const shareableId = 'atomic001a'
    await seedShareable(shareableId)

    await Promise.all([
      transitionBatch(shareableId, 'credential-atomic-1'),
      transitionBatch(shareableId, 'credential-atomic-2'),
    ])

    const eventCount = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE shareable_id = ? AND type = 'link_suspended'",
      )
      .bind(shareableId)
      .first<{ count: number }>()
    const auditCount = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE subject_id = ? AND action = 'shareable.link.suspend'",
      )
      .bind(shareableId)
      .first<{ count: number }>()
    const shareable = await db
      .prepare('SELECT link_suspended_at FROM shareables WHERE id = ?')
      .bind(shareableId)
      .first<{ link_suspended_at: string | null }>()

    expect(Number(eventCount?.count)).toBe(1)
    expect(Number(auditCount?.count)).toBe(1)
    expect(shareable?.link_suspended_at).toBe('2026-09-08T01:00:00.000Z')
  })

  it('classifies concurrent appeals from the same transactional batch', async () => {
    const shareableId = 'atomic002a'
    await seedShareable(shareableId)
    await db
      .prepare(
        "UPDATE shareables SET link_suspended_at = '2026-09-08T01:00:00.000Z' WHERE id = ?",
      )
      .bind(shareableId)
      .run()
    const now = '2026-09-08T02:00:00.000Z'
    const since = '2026-09-08T01:00:00.000Z'

    const appeal = (eventId: string) =>
      db.batch([
        db
          .prepare(
            `INSERT INTO events (
              id, workspace_id, type, shareable_id, actor_user_id, subject_id,
              payload, created_at
            )
            SELECT ?, workspace_id, 'link_appealed', id, 'atomic-owner', ?, '{}', ?
            FROM shareables
            WHERE id = ? AND owner_user_id = 'atomic-owner'
              AND link_suspended_at IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM events recent
                WHERE recent.shareable_id = shareables.id
                  AND recent.type = 'link_appealed'
                  AND recent.created_at >= ?
              )`,
          )
          .bind(eventId, `${eventId}-subject`, now, shareableId, since),
        db
          .prepare(
            `SELECT
              EXISTS(SELECT 1 FROM events WHERE id = ?) AS inserted,
              EXISTS(SELECT 1 FROM shareables WHERE id = ?) AS found,
              EXISTS(SELECT 1 FROM shareables WHERE id = ? AND owner_user_id = 'atomic-owner') AS owned,
              EXISTS(SELECT 1 FROM shareables WHERE id = ? AND link_suspended_at IS NOT NULL) AS suspended`,
          )
          .bind(eventId, shareableId, shareableId, shareableId),
      ])

    const results = await Promise.all([
      appeal('appeal-atomic-1'),
      appeal('appeal-atomic-2'),
    ])
    const inserted = results.map((result) =>
      Number((result[1].results[0] as { inserted: number }).inserted),
    )
    const count = await db
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE shareable_id = ? AND type = 'link_appealed'",
      )
      .bind(shareableId)
      .first<{ count: number }>()

    expect(inserted.sort()).toEqual([0, 1])
    expect(Number(count?.count)).toBe(1)
  })
})
