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

describe.sequential('D1 compatibility', () => {
  it('applies the project migrations', async () => {
    const result = await db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'users'`,
      )
      .first<{ name: string }>()

    expect(result?.name).toBe('users')
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
