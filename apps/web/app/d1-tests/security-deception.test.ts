import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createTestHarness, unstable_splitSqlQuery } from 'wrangler'
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest'
import { sql } from 'kysely'

vi.mock('cloudflare:workers', () => ({
  env: {
    get DB() {
      return database
    },
  },
}))
vi.mock('../services/auth.server', () => ({ readBearerSessionToken: vi.fn() }))
const send = vi.hoisted(() => vi.fn(async () => ({ ok: true })))
vi.mock('../services/slack.server', () => ({ postSlackWebhook: send }))
import { createDb, type Db } from '../services/db.server'
import {
  admitDeceptionSignal,
  claimDeceptionSignals,
  drainDeceptionSignals,
  reserveDeceptionDelivery,
} from '../services/security-deception.server'
import { cleanupExpiredDeceptionSignals } from '../services/security-audit.server'
import type { DeceptionPrincipal } from '../services/security-deception-auth.server'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let database: D1Database
let db: Db
const at = Date.parse('2026-11-15T12:00:00.000Z')
const principal: DeceptionPrincipal = {
  actor_kind: 'human',
  actor_id: 'u1',
  workspace_id: 'ws1',
  auth_route: 'cli_session',
  client_kind: null,
  client_id: null,
  authority_kind: 'unrestricted',
  agent_profile_id: null,
  publisher_client_id: null,
}
beforeAll(async () => {
  await server.listen()
  database = (await worker.getEnv()).DB
  db = createDb(database)
  const baseline = '0055_d1_name_cutover_clean_rebuild_v2.sql'
  await database.batch(
    unstable_splitSqlQuery(
      readFileSync(
        new URL(`../../db/baselines/${baseline}`, import.meta.url),
        'utf8',
      ),
    )
      .filter((s) => !/^\s*PRAGMA/iu.test(s))
      .map((s) => database.prepare(s)),
  )
  for (const name of readdirSync(
    new URL('../../db/migrations/', import.meta.url),
  ).sort()) {
    if (name <= baseline || !name.endsWith('.sql')) continue
    await database.batch(
      unstable_splitSqlQuery(
        readFileSync(
          new URL(`../../db/migrations/${name}`, import.meta.url),
          'utf8',
        ),
      ).map((s) => database.prepare(s)),
    )
  }
})
afterAll(async () => {
  await db?.destroy()
  await server.close()
})
beforeEach(async () => {
  await db.deleteFrom('security_deception_signals').execute()
  await db
    .updateTable('security_deception_delivery_control')
    .set({
      next_send_at: '1970-01-01T00:00:00.000Z',
      lease_token: null,
      lease_expires_at: null,
      saturated_day: null,
    })
    .execute()
  send.mockClear()
})
async function count() {
  return Number(
    (
      await db
        .selectFrom('security_deception_signals')
        .select((eb) => eb.fn.countAll().as('n'))
        .executeTakeFirstOrThrow()
    ).n,
  )
}
async function seedCopies(n: number, date = new Date(at)) {
  await admitDeceptionSignal(db, principal, date)
  // Populate known existing rows; tested admissions below use production SQL.
  await sql`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n < ${n - 1})
    INSERT INTO security_deception_signals(id, decoy_id, reason, actor_kind, actor_id, workspace_id, auth_route, first_detected_at, day_bucket, hour_bucket, next_attempt_at)
    SELECT ${String(date.getTime())} || '-' || n, decoy_id, reason, actor_kind, ${String(date.getTime())} || '-' || n, workspace_id, auth_route, first_detected_at, day_bucket, hour_bucket, next_attempt_at
    FROM numbers CROSS JOIN security_deception_signals WHERE actor_id = 'u1' AND first_detected_at = ${date.toISOString()}`.execute(
    db,
  )
}

test('real D1 conditional admission serializes duplicate and cap contenders', async () => {
  const duplicates = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      admitDeceptionSignal(
        db,
        {
          ...principal,
          client_kind: 'oauth_client',
          client_id: `rotated-${i}`,
        },
        new Date(at),
      ),
    ),
  )
  expect(duplicates.filter((v) => v === 'admitted')).toHaveLength(1)
  expect(await count()).toBe(1)
  await db.deleteFrom('security_deception_signals').execute()
  await seedCopies(997)
  expect(await count()).toBe(997)
  const contenders = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      admitDeceptionSignal(
        db,
        { ...principal, actor_id: `contender-${i}` },
        new Date(at),
      ),
    ),
  )
  expect(contenders.filter((v) => v === 'admitted')).toHaveLength(3)
  expect(contenders.filter((v) => v === 'saturated')).toHaveLength(17)
  expect(await count()).toBe(1000)
  await Promise.all(
    Array.from({ length: 10 }, () =>
      admitDeceptionSignal(
        db,
        { ...principal, actor_id: 'suppressed' },
        new Date(at),
      ),
    ),
  )
  expect(await count()).toBe(1000)
  const control = await db
    .selectFrom('security_deception_delivery_control')
    .selectAll()
    .execute()
  expect(control).toHaveLength(1)
  expect(control[0]!.saturated_day).toBe('2026-11-15')
  expect(
    await admitDeceptionSignal(db, principal, new Date(at + 86400000)),
  ).toBe('admitted')
  expect(await count()).toBe(1001)
})

test('real D1 competing reservations and conditional claims yield only one digest', async () => {
  await seedCopies(20)
  const winners = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      reserveDeceptionDelivery(db, at, `lease-${i}`),
    ),
  )
  expect(winners.filter(Boolean)).toHaveLength(1)
  const token = `lease-${winners.indexOf(true)}`
  const claims = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      claimDeceptionSignals(db, at, `lease-${i}`),
    ),
  )
  expect(claims.flat()).toHaveLength(10)
  expect(new Set(claims.flat().map((row) => row.id)).size).toBe(10)
  expect(await claimDeceptionSignals(db, at + 60000, token)).toHaveLength(0)
  expect(await reserveDeceptionDelivery(db, at + 299999, 'too-early')).toBe(
    false,
  )
  // Restart after crash: expired row leases become eligible, budget persists.
  await Promise.all([
    drainDeceptionSignals(db, 'https://synthetic.invalid', () => at + 300000),
    drainDeceptionSignals(db, 'https://synthetic.invalid', () => at + 300000),
  ])
  expect(send).toHaveBeenCalledTimes(1)
  expect(
    await db
      .selectFrom('security_deception_signals')
      .select('id')
      .where('status', '=', 'delivered')
      .execute(),
  ).toHaveLength(10)
  expect(
    (
      await db
        .selectFrom('security_deception_delivery_control')
        .selectAll()
        .executeTakeFirstOrThrow()
    ).next_send_at,
  ).toBe(new Date(at + 600000).toISOString())
})

test('real D1 restores an observed unsent attempt without releasing reservation budget', async () => {
  await admitDeceptionSignal(db, principal, new Date(at))
  let ticks = 0
  await expect(
    drainDeceptionSignals(db, 'https://synthetic.invalid', () =>
      ++ticks >= 6 ? at + 60000 : at,
    ),
  ).rejects.toThrow('unhealthy')
  expect(send).not.toHaveBeenCalled()
  expect(
    await db.selectFrom('security_deception_signals').selectAll().execute(),
  ).toMatchObject([
    {
      status: 'retry',
      failure_code: 'dispatch_expired',
      attempt_count: 0,
      last_attempt_at: null,
    },
  ])
  expect(await reserveDeceptionDelivery(db, at + 299999, 'early')).toBe(false)
  await expect(
    sql`UPDATE security_deception_signals SET failure_code = 'unknown'`.execute(
      db,
    ),
  ).rejects.toThrow()
  await Promise.all([
    drainDeceptionSignals(db, 'https://synthetic.invalid', () => at + 360000),
    drainDeceptionSignals(db, 'https://synthetic.invalid', () => at + 360000),
  ])
  expect(send).toHaveBeenCalledTimes(1)
  expect(
    await db.selectFrom('security_deception_signals').selectAll().execute(),
  ).toMatchObject([{ status: 'delivered', attempt_count: 1 }])
})

test('real D1 migration constraints and multi-batch inclusive retention', async () => {
  await seedCopies(1000, new Date(at - 86400000))
  await seedCopies(999)
  await admitDeceptionSignal(
    db,
    { ...principal, actor_id: 'keep' },
    new Date(at + 1),
  )
  expect(await count()).toBe(2000)
  await db
    .updateTable('security_deception_signals')
    .set({ status: 'failed', failure_code: 'http_rejected' })
    .where('first_detected_at', '<', new Date(at).toISOString())
    .execute()
  await expect(
    db
      .updateTable('security_deception_signals')
      .set({ hour_bucket: '12' })
      .execute(),
  ).rejects.toThrow()
  await expect(
    db
      .updateTable('security_deception_signals')
      .set({ attempt_count: -1 })
      .execute(),
  ).rejects.toThrow()
  await expect(
    db
      .updateTable('security_deception_delivery_control')
      .set({ id: 2 })
      .execute(),
  ).rejects.toThrow()
  expect(
    await cleanupExpiredDeceptionSignals(db, new Date(at + 400 * 86400000)),
  ).toBe(1000)
  expect(
    await cleanupExpiredDeceptionSignals(db, new Date(at + 400 * 86400000)),
  ).toBe(999)
  expect(
    await cleanupExpiredDeceptionSignals(db, new Date(at + 400 * 86400000)),
  ).toBe(0)
  expect(
    await db.selectFrom('security_deception_signals').selectAll().execute(),
  ).toMatchObject([{ actor_id: 'keep' }])
})
