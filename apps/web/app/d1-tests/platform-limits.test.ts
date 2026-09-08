import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let db: D1Database
const migrationsDir = fileURLToPath(
  new URL('../../db/migrations', import.meta.url),
)

beforeAll(async () => {
  await server.listen()
  await worker.applyD1Migrations('DB')
  db = (await worker.getEnv()).DB
})

afterAll(async () => {
  await server.close()
})

const compoundSelect = (terms: number) =>
  Array.from(
    { length: terms },
    (_, index) => `SELECT ${index + 1} AS value`,
  ).join(' UNION ALL ')

const placeholders = (count: number) =>
  Array.from({ length: count }, () => '?').join(', ')

async function executeSqlBatch(database: D1Database, sql: string) {
  const statements = unstable_splitSqlQuery(sql)
  await database.batch(
    statements.map((statement) => database.prepare(statement)),
  )
}

async function applyMigrationSql(database: D1Database, path: string) {
  await executeSqlBatch(database, readFileSync(path, 'utf8'))
}

const testTimestamp = '2026-09-08T12:00:00.000Z'
const windowStart = '2026-09-07T12:00:00.000Z'

async function seedWorkspace(database: D1Database, workspaceId: string) {
  const userId = `${workspaceId}-user`
  const containerId = `${workspaceId}-inbox`

  await database.batch([
    database
      .prepare(
        `INSERT INTO workspaces (id, name, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(workspaceId, workspaceId, testTimestamp),
    database
      .prepare(
        `INSERT INTO users (
           id, email, email_verified, name, created_at, updated_at, workspace_id,
           google_sub
         ) VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .bind(
        userId,
        `${workspaceId}@example.com`,
        userId,
        testTimestamp,
        testTimestamp,
        workspaceId,
        `${workspaceId}-sub`,
      ),
    database
      .prepare(
        `INSERT INTO artifact_containers (
           id, workspace_id, kind, owner_user_id, created_by_id, name,
           created_at, updated_at
         ) VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?)`,
      )
      .bind(
        containerId,
        workspaceId,
        userId,
        userId,
        containerId,
        testTimestamp,
        testTimestamp,
      ),
  ])

  return { containerId, userId }
}

function insertShareable(
  database: D1Database,
  args: {
    containerId: string
    id: string
    timestamp: string
    userId: string
    visibility: 'link' | 'private'
    workspaceId: string
  },
) {
  return database
    .prepare(
      `INSERT INTO shareables (
         id, workspace_id, owner_user_id, name, artifact_kind, visibility,
         created_at, updated_at, container_id
       ) VALUES (?, ?, ?, ?, 'html_page', ?, ?, ?, ?)`,
    )
    .bind(
      args.id,
      args.workspaceId,
      args.userId,
      args.id,
      args.visibility,
      args.timestamp,
      args.timestamp,
      args.containerId,
    )
}

function publicationAttempt(
  database: D1Database,
  args: {
    dailyLimit: number
    id: string
    publishedAt?: string
    workspaceId: string
  },
) {
  return database
    .prepare(
      `INSERT INTO link_publication_attempts (
         workspace_id, shareable_id, published_at, window_start,
         daily_limit, limit_applies
       ) VALUES (?, ?, ?, ?, ?, 1)`,
    )
    .bind(
      args.workspaceId,
      args.id,
      args.publishedAt ?? testTimestamp,
      windowStart,
      args.dailyLimit,
    )
}

function attemptCleanup(database: D1Database, workspaceId: string, id: string) {
  return [
    database
      .prepare(
        `DELETE FROM link_publication_attempts
         WHERE workspace_id = ? AND shareable_id = ? AND consumed = 0`,
      )
      .bind(workspaceId, id),
    database
      .prepare(
        `DELETE FROM link_publication_attempts
         WHERE workspace_id = ? AND shareable_id = ?`,
      )
      .bind(workspaceId, id),
  ]
}

function publishNewShareable(
  database: D1Database,
  fixture: { containerId: string; userId: string },
  args: {
    dailyLimit: number
    id: string
    publishedAt?: string
    workspaceId: string
  },
) {
  return database.batch([
    publicationAttempt(database, args),
    insertShareable(database, {
      ...fixture,
      id: args.id,
      timestamp: args.publishedAt ?? testTimestamp,
      visibility: 'link',
      workspaceId: args.workspaceId,
    }),
    ...attemptCleanup(database, args.workspaceId, args.id),
  ])
}

function republishShareable(
  database: D1Database,
  args: {
    dailyLimit: number
    id: string
    publishedAt?: string
    workspaceId: string
  },
) {
  const publishedAt = args.publishedAt ?? testTimestamp
  return database.batch([
    publicationAttempt(database, args),
    database
      .prepare(
        `UPDATE shareables
         SET visibility = 'link', updated_at = ?
         WHERE workspace_id = ? AND id = ?`,
      )
      .bind(publishedAt, args.workspaceId, args.id),
    ...attemptCleanup(database, args.workspaceId, args.id),
  ])
}

describe.sequential('D1 compatibility', () => {
  it('applies the project migrations', async () => {
    const result = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`,
      )
      .first<{ name: string }>()

    expect(result?.name).toBe('users')
  })

  it('uses the workspace-scoped event index for bounded link-publish counts', async () => {
    const plan = await db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT COUNT(*)
         FROM (
           SELECT 1
           FROM events
           WHERE type = 'visibility_changed'
             AND workspace_id = 'workspace-under-test'
             AND json_extract(payload, '$.to') = 'link'
           GROUP BY shareable_id
           LIMIT 5
         )`,
      )
      .all<{ detail: string }>()

    expect(plan.results.map((step) => step.detail).join('\n')).toContain(
      'events_type_workspace_shareable',
    )
  })

  it('allows five compound SELECT terms', async () => {
    const result = await db.prepare(compoundSelect(5)).all()

    expect(result.results).toHaveLength(5)
  })

  it('rejects six compound SELECT terms', async () => {
    await expect(db.prepare(compoundSelect(6)).all()).rejects.toThrow(
      /too many terms in compound SELECT/i,
    )
  })

  it('allows a compound SELECT inside EXISTS', async () => {
    const result = await db
      .prepare(`SELECT EXISTS(${compoundSelect(5)}) AS present`)
      .first<{ present: number }>()

    expect(result?.present).toBe(1)
  })

  it('allows 100 bound parameters', async () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1)
    const result = await db
      .prepare(`SELECT 1 IN (${placeholders(values.length)}) AS present`)
      .bind(...values)
      .first<{ present: number }>()

    expect(result?.present).toBe(1)
  })

  it('rejects 101 bound parameters', async () => {
    const values = Array.from({ length: 101 }, (_, index) => index + 1)
    const query = db
      .prepare(`SELECT 1 IN (${placeholders(values.length)}) AS present`)
      .bind(...values)

    await expect(query.first()).rejects.toThrow(/too many SQL variables/i)
  })

  it('allows a 50-byte LIKE pattern', async () => {
    const result = await db
      .prepare(`SELECT 'x' LIKE ? AS matches`)
      .bind('x'.repeat(50))
      .first<{ matches: number }>()

    expect(result?.matches).toBe(0)
  })

  it('rejects a 51-byte LIKE pattern', async () => {
    const query = db
      .prepare(`SELECT 'x' LIKE ? AS matches`)
      .bind('x'.repeat(51))

    await expect(query.first()).rejects.toThrow(
      /LIKE or GLOB pattern too complex/i,
    )
  })

  it.each([
    ['ASCII', `${'x'.repeat(100)}z`],
    ['multibyte', `${'界'.repeat(100)}終`],
    ['LIKE metacharacters', '%_\\'.repeat(100)],
  ])('matches the full %s input with instr()', async (_, input) => {
    const result = await db
      .prepare(`SELECT instr(?, ?) AS position`)
      .bind(`prefix:${input}:suffix`, input)
      .first<{ position: number }>()

    expect(result?.position).toBeGreaterThan(0)
  })

  it('rolls back atomic sharing attempts on the final named assertions', async () => {
    await db
      .prepare(
        `INSERT INTO workspaces (id, name, created_at)
         VALUES ('atomic-grants-ws', 'Atomic grants', '2026-09-08T00:00:00.000Z')`,
      )
      .run()
    const insertAttempt = (shareableId: string, consumed: number) =>
      db
        .prepare(
          `INSERT INTO link_publication_attempts (
             workspace_id, shareable_id, published_at, window_start,
             daily_limit, limit_applies, consumed
           ) VALUES (
             'atomic-grants-ws', ?, '2026-09-08T00:00:00.000Z',
             '2026-09-07T00:00:00.000Z', 20, 0, ?
           )`,
        )
        .bind(shareableId, consumed)

    await expect(
      db.batch([
        insertAttempt('unconsumed', 0),
        db.prepare(
          `DELETE FROM link_publication_attempts
           WHERE workspace_id = 'atomic-grants-ws'
             AND shareable_id = 'unconsumed'`,
        ),
      ]),
    ).rejects.toThrow(/link publication mutation missing/i)

    await expect(
      db.batch([
        insertAttempt('missing-grant', 1),
        db.prepare(
          `UPDATE link_publication_attempts
           SET requested_grants_present = 0
           WHERE workspace_id = 'atomic-grants-ws'
             AND shareable_id = 'missing-grant'`,
        ),
      ]),
    ).rejects.toThrow(/link_publication_all_requested_grants_present/i)

    await db.batch([
      insertAttempt('consumed', 1),
      db.prepare(
        `DELETE FROM link_publication_attempts
         WHERE workspace_id = 'atomic-grants-ws'
           AND shareable_id = 'consumed'`,
      ),
    ])
    const attempts = await db
      .prepare(
        `SELECT shareable_id FROM link_publication_attempts
         WHERE workspace_id = 'atomic-grants-ws'`,
      )
      .all()
    expect(attempts.results).toEqual([])
  })

  it('serializes two and many publication batches at the remaining capacity', async () => {
    const twoWorkspaceId = 'publication-race-two'
    const twoFixture = await seedWorkspace(db, twoWorkspaceId)
    await db
      .prepare(
        `INSERT INTO link_publications (
           workspace_id, shareable_id, latest_published_at
         ) VALUES (?, 'already-counted', ?)`,
      )
      .bind(twoWorkspaceId, '2026-09-08T11:00:00.000Z')
      .run()

    const twoResults = await Promise.allSettled(
      ['two-a', 'two-b'].map((id) =>
        publishNewShareable(db, twoFixture, {
          dailyLimit: 2,
          id,
          workspaceId: twoWorkspaceId,
        }),
      ),
    )
    expect(
      twoResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    const twoFailures = twoResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(twoFailures).toHaveLength(1)
    expect(String(twoFailures[0]?.reason)).toMatch(
      /link publication quota exceeded/i,
    )

    const twoState = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM shareables WHERE workspace_id = ?) AS artifacts,
           (SELECT COUNT(*) FROM link_publications WHERE workspace_id = ?) AS publications,
           (SELECT COUNT(*) FROM link_publication_attempts WHERE workspace_id = ?) AS attempts`,
      )
      .bind(twoWorkspaceId, twoWorkspaceId, twoWorkspaceId)
      .first<{ artifacts: number; attempts: number; publications: number }>()
    expect(twoState).toEqual({ artifacts: 1, attempts: 0, publications: 2 })

    const manyWorkspaceId = 'publication-race-many'
    const manyFixture = await seedWorkspace(db, manyWorkspaceId)
    await db.batch(
      ['many-seed-a', 'many-seed-b'].map((id) =>
        db
          .prepare(
            `INSERT INTO link_publications (
               workspace_id, shareable_id, latest_published_at
             ) VALUES (?, ?, ?)`,
          )
          .bind(manyWorkspaceId, id, '2026-09-08T10:00:00.000Z'),
      ),
    )

    const manyResults = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => `many-${index}`).map((id) =>
        publishNewShareable(db, manyFixture, {
          dailyLimit: 5,
          id,
          workspaceId: manyWorkspaceId,
        }),
      ),
    )
    expect(
      manyResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(3)
    const manyFailures = manyResults.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    )
    expect(manyFailures).toHaveLength(7)
    expect(
      manyFailures.every((result) =>
        /link publication quota exceeded/i.test(String(result.reason)),
      ),
    ).toBe(true)

    const manyState = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM shareables WHERE workspace_id = ?) AS artifacts,
           (SELECT COUNT(*) FROM link_publications WHERE workspace_id = ?) AS publications,
           (SELECT COUNT(*) FROM link_publication_attempts WHERE workspace_id = ?) AS attempts`,
      )
      .bind(manyWorkspaceId, manyWorkspaceId, manyWorkspaceId)
      .first<{ artifacts: number; attempts: number; publications: number }>()
    expect(manyState).toEqual({ artifacts: 3, attempts: 0, publications: 5 })
  })

  it('serializes a republish and a distinct publication racing for the last slot', async () => {
    const workspaceId = 'publication-race-republish'
    const fixture = await seedWorkspace(db, workspaceId)
    await db.batch([
      insertShareable(db, {
        ...fixture,
        id: 'hidden-republish',
        timestamp: '2026-09-06T12:00:00.000Z',
        visibility: 'private',
        workspaceId,
      }),
      db
        .prepare(
          `INSERT INTO link_publications (
             workspace_id, shareable_id, latest_published_at
           ) VALUES (?, 'hidden-republish', '2026-09-06T12:00:00.000Z'),
                    (?, 'already-counted', '2026-09-08T11:00:00.000Z')`,
        )
        .bind(workspaceId, workspaceId),
    ])

    const results = await Promise.allSettled([
      republishShareable(db, {
        dailyLimit: 2,
        id: 'hidden-republish',
        workspaceId,
      }),
      publishNewShareable(db, fixture, {
        dailyLimit: 2,
        id: 'distinct-publication',
        workspaceId,
      }),
    ])
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1)

    const counted = await db
      .prepare(
        `SELECT shareable_id FROM link_publications
         WHERE workspace_id = ? AND latest_published_at > ?
         ORDER BY shareable_id`,
      )
      .bind(workspaceId, windowStart)
      .all<{ shareable_id: string }>()
    expect(counted.results).toHaveLength(2)
    expect(counted.results.map((row) => row.shareable_id)).toContain(
      'already-counted',
    )
    expect(
      counted.results.filter((row) =>
        ['hidden-republish', 'distinct-publication'].includes(row.shareable_id),
      ),
    ).toHaveLength(1)

    const attempts = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM link_publication_attempts
         WHERE workspace_id = ?`,
      )
      .bind(workspaceId)
      .first<{ count: number }>()
    expect(attempts?.count).toBe(0)
  })

  it('rolls back publication, visibility, event, and context after a trigger succeeds', async () => {
    const workspaceId = 'publication-post-trigger-rollback'
    const fixture = await seedWorkspace(db, workspaceId)
    await insertShareable(db, {
      ...fixture,
      id: 'rollback-target',
      timestamp: '2026-09-08T10:00:00.000Z',
      visibility: 'private',
      workspaceId,
    }).run()

    await expect(
      db.batch([
        publicationAttempt(db, {
          dailyLimit: 2,
          id: 'rollback-target',
          workspaceId,
        }),
        db
          .prepare(
            `INSERT INTO events (
               id, workspace_id, type, shareable_id, actor_user_id,
               subject_id, payload, created_at
             ) VALUES (
               'rollback-event', ?, 'visibility_changed', ?, ?,
               'rollback-target', '{"from":"private","to":"link"}', ?
             )`,
          )
          .bind(workspaceId, 'rollback-target', fixture.userId, testTimestamp),
        db
          .prepare(
            `UPDATE shareables SET visibility = 'link', updated_at = ?
             WHERE workspace_id = ? AND id = 'rollback-target'`,
          )
          .bind(testTimestamp, workspaceId),
        db
          .prepare(
            `UPDATE link_publication_attempts
             SET requested_grants_present = 0
             WHERE workspace_id = ? AND shareable_id = 'rollback-target'`,
          )
          .bind(workspaceId),
        ...attemptCleanup(db, workspaceId, 'rollback-target'),
      ]),
    ).rejects.toThrow(/link_publication_all_requested_grants_present/i)

    const state = await db
      .prepare(
        `SELECT
           (SELECT visibility FROM shareables WHERE id = 'rollback-target') AS visibility,
           (SELECT COUNT(*) FROM events WHERE id = 'rollback-event') AS events,
           (SELECT COUNT(*) FROM link_publications
             WHERE workspace_id = ? AND shareable_id = 'rollback-target') AS publications,
           (SELECT COUNT(*) FROM link_publication_attempts
             WHERE workspace_id = ? AND shareable_id = 'rollback-target') AS attempts`,
      )
      .bind(workspaceId, workspaceId)
      .first<{
        attempts: number
        events: number
        publications: number
        visibility: string
      }>()
    expect(state).toEqual({
      attempts: 0,
      events: 0,
      publications: 0,
      visibility: 'private',
    })
  })

  it.each(['same', 'cross'] as const)(
    'keeps active IDs global during a %s-workspace create/delete race',
    async (scope) => {
      const sourceWorkspaceId = `active-id-${scope}-source`
      const destinationWorkspaceId =
        scope === 'same' ? sourceWorkspaceId : `active-id-${scope}-destination`
      const source = await seedWorkspace(db, sourceWorkspaceId)
      const destination =
        scope === 'same'
          ? source
          : await seedWorkspace(db, destinationWorkspaceId)
      const id = `active-id-${scope}`

      await insertShareable(db, {
        ...source,
        id,
        timestamp: testTimestamp,
        visibility: 'link',
        workspaceId: sourceWorkspaceId,
      }).run()

      const results = await Promise.allSettled([
        db.prepare(`DELETE FROM shareables WHERE id = ?`).bind(id).run(),
        insertShareable(db, {
          ...destination,
          id,
          timestamp: testTimestamp,
          visibility: 'private',
          workspaceId: destinationWorkspaceId,
        }).run(),
      ])
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1)
      const failures = results.filter(
        (result): result is PromiseRejectedResult =>
          result.status === 'rejected',
      )
      expect(failures).toHaveLength(1)
      expect(String(failures[0]?.reason)).toMatch(
        /UNIQUE constraint failed: shareables\.id/i,
      )

      const row = await db
        .prepare(`SELECT workspace_id FROM shareables WHERE id = ?`)
        .bind(id)
        .first()
      expect(row).toBeNull()
      const history = await db
        .prepare(
          `SELECT workspace_id, latest_published_at FROM link_publications
           WHERE shareable_id = ?`,
        )
        .bind(id)
        .first()
      expect(history).toEqual({
        latest_published_at: testTimestamp,
        workspace_id: sourceWorkspaceId,
      })
    },
  )

  it('allows global ID reuse at the exact active-history boundary', async () => {
    const sourceWorkspaceId = 'active-id-boundary-source'
    const destinationWorkspaceId = 'active-id-boundary-destination'
    const source = await seedWorkspace(db, sourceWorkspaceId)
    const destination = await seedWorkspace(db, destinationWorkspaceId)
    const id = 'active-id-boundary'

    await insertShareable(db, {
      ...source,
      id,
      timestamp: testTimestamp,
      visibility: 'link',
      workspaceId: sourceWorkspaceId,
    }).run()
    await db.prepare(`DELETE FROM shareables WHERE id = ?`).bind(id).run()
    await insertShareable(db, {
      ...destination,
      id,
      timestamp: '2026-09-09T12:00:00.000Z',
      visibility: 'private',
      workspaceId: destinationWorkspaceId,
    }).run()

    const reused = await db
      .prepare(`SELECT workspace_id, visibility FROM shareables WHERE id = ?`)
      .bind(id)
      .first()
    expect(reused).toEqual({
      visibility: 'private',
      workspace_id: destinationWorkspaceId,
    })
  })

  it('uses scalar MAX and trigger-local changes for out-of-order republishes', async () => {
    const workspaceId = 'publication-out-of-order'
    const fixture = await seedWorkspace(db, workspaceId)
    const id = 'out-of-order-target'
    await insertShareable(db, {
      ...fixture,
      id,
      timestamp: '2026-09-08T09:00:00.000Z',
      visibility: 'private',
      workspaceId,
    }).run()

    const later = '2026-09-08T11:30:00.000Z'
    const earlier = '2026-09-08T11:00:00.000Z'
    await republishShareable(db, {
      dailyLimit: 2,
      id,
      publishedAt: later,
      workspaceId,
    })
    await db
      .prepare(`UPDATE shareables SET visibility = 'private' WHERE id = ?`)
      .bind(id)
      .run()

    await republishShareable(db, {
      dailyLimit: 2,
      id,
      publishedAt: earlier,
      workspaceId,
    })
    let publication = await db
      .prepare(
        `SELECT latest_published_at FROM link_publications
         WHERE workspace_id = ? AND shareable_id = ?`,
      )
      .bind(workspaceId, id)
      .first<{ latest_published_at: string }>()
    expect(publication?.latest_published_at).toBe(later)

    await db
      .prepare(
        `UPDATE shareables
         SET visibility = 'private', updated_at = '2026-09-08T10:30:00.000Z'
         WHERE id = ?`,
      )
      .bind(id)
      .run()
    await db
      .prepare(
        `UPDATE shareables
         SET visibility = 'link', updated_at = '2026-09-08T10:30:00.000Z'
         WHERE id = ?`,
      )
      .bind(id)
      .run()
    publication = await db
      .prepare(
        `SELECT latest_published_at FROM link_publications
         WHERE workspace_id = ? AND shareable_id = ?`,
      )
      .bind(workspaceId, id)
      .first<{ latest_published_at: string }>()
    expect(publication?.latest_published_at).toBe(later)

    await db.batch([
      publicationAttempt(db, {
        dailyLimit: 1,
        id,
        publishedAt: '2026-09-08T11:45:00.000Z',
        workspaceId,
      }),
      db
        .prepare(
          `UPDATE shareables SET visibility = 'link', updated_at = ?
           WHERE workspace_id = ? AND id = ?`,
        )
        .bind('2026-09-08T11:45:00.000Z', workspaceId, id),
      ...attemptCleanup(db, workspaceId, id),
    ])
    const finalState = await db
      .prepare(
        `SELECT
           (SELECT latest_published_at FROM link_publications
             WHERE workspace_id = ? AND shareable_id = ?) AS latest_published_at,
           (SELECT COUNT(*) FROM link_publication_attempts
             WHERE workspace_id = ? AND shareable_id = ?) AS attempts`,
      )
      .bind(workspaceId, id, workspaceId, id)
      .first<{ attempts: number; latest_published_at: string }>()
    expect(finalState).toEqual({ attempts: 0, latest_published_at: later })
  })

  it('preserves parent and child rows during a protected table rebuild', async () => {
    await server.reset()
    db = (await worker.getEnv()).DB

    const targetMigration = '0082_relax_agent_authority_project_check.sql'
    for (const name of readdirSync(migrationsDir).sort()) {
      if (name === targetMigration) break
      if (!name.endsWith('.sql')) continue
      await applyMigrationSql(db, join(migrationsDir, name))
    }

    await executeSqlBatch(
      db,
      `
      INSERT INTO workspaces (id, name, created_at)
      VALUES ('w1', 'W1', '2026-01-01');
      INSERT INTO users (
        id, email, email_verified, name, created_at, updated_at,
        workspace_id, google_sub
      ) VALUES (
        'u1', 'u1@example.com', 1, 'U1', '2026-01-01', '2026-01-01',
        'w1', 'sub1'
      );
      INSERT INTO artifact_containers (
        id, workspace_id, kind, owner_user_id, created_by_id, name,
        created_at, updated_at
      ) VALUES ('p1', 'w1', 'project', 'u1', 'u1', 'P1',
        '2026-01-01', '2026-01-01');
      INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
      VALUES ('agent-1', 'u1', 'w1', '2026-01-01');
      INSERT INTO cli_family_authorities (
        family_id, user_id, preset, workspace_id, project_id,
        project_name_snapshot, agent_profile_id, approved_at, device_name,
        status, created_at, updated_at
      ) VALUES ('family-1', 'u1', 'agent', 'w1', 'p1', 'P1', 'agent-1',
        '2026-01-01', 'Laptop', 'active', '2026-01-01', '2026-01-01');
      INSERT INTO sessions (
        id, user_id, token, expires_at, created_at, updated_at
      ) VALUES
        ('s1', 'u1', 'tok1', '2099-01-01', '2026-01-01', '2026-01-01'),
        ('s2', 'u1', 'tok2', '2099-01-01', '2026-01-01', '2026-01-01');
      INSERT INTO cli_session_authorities (
        session_id, family_id, kind, preset, workspace_id, project_id,
        agent_profile_id, expires_at, bearer_only, created_at
      ) VALUES
        ('s1', 'family-1', 'family', 'agent', NULL, NULL,
          NULL, NULL, 1, '2026-01-01'),
        ('s2', NULL, 'bootstrap', 'agent', 'w1', 'p1',
          'agent-1', '2099-01-01', 1, '2026-01-01');
      `,
    )

    await applyMigrationSql(db, join(migrationsDir, targetMigration))

    const family = await db
      .prepare(
        `SELECT family_id, preset, workspace_id, project_id,
                project_name_snapshot, agent_profile_id, status
           FROM cli_family_authorities`,
      )
      .first()
    expect(family).toEqual({
      family_id: 'family-1',
      preset: 'agent',
      workspace_id: 'w1',
      project_id: 'p1',
      project_name_snapshot: 'P1',
      agent_profile_id: 'agent-1',
      status: 'active',
    })

    const sessions = await db
      .prepare(
        `SELECT session_id, family_id, kind, preset, workspace_id,
                project_id, agent_profile_id, expires_at, bearer_only,
                created_at
           FROM cli_session_authorities
          ORDER BY session_id`,
      )
      .all()
    expect(sessions.results).toEqual([
      {
        session_id: 's1',
        family_id: 'family-1',
        kind: 'family',
        preset: 'agent',
        workspace_id: null,
        project_id: null,
        agent_profile_id: null,
        expires_at: null,
        bearer_only: 1,
        created_at: '2026-01-01',
      },
      {
        session_id: 's2',
        family_id: null,
        kind: 'bootstrap',
        preset: 'agent',
        workspace_id: 'w1',
        project_id: 'p1',
        agent_profile_id: 'agent-1',
        expires_at: '2099-01-01',
        bearer_only: 1,
        created_at: '2026-01-01',
      },
    ])

    const foreignKeys = await db.prepare('PRAGMA foreign_key_check').all()
    expect(foreignKeys.results).toEqual([])

    const temporaryTables = await db
      .prepare(
        `SELECT COUNT(*) AS count FROM sqlite_master
          WHERE name LIKE '%_tmp' OR name LIKE '_migration_0082%'`,
      )
      .first<{ count: number }>()
    expect(temporaryTables?.count).toBe(0)

    await db
      .prepare(
        `UPDATE cli_family_authorities
            SET project_id = NULL
          WHERE family_id = 'family-1'`,
      )
      .run()
    const detached = await db
      .prepare(
        `SELECT project_id FROM cli_family_authorities
          WHERE family_id = 'family-1'`,
      )
      .first<{ project_id: string | null }>()
    expect(detached?.project_id).toBeNull()
  })
})
