// Bot member lifecycle against a real D1 (Workers test harness). Rollback and
// atomicity assertions live here on purpose: the SQLite service tests run
// batches sequentially without a transaction, so only this suite can verify
// batch-level all-or-nothing behavior and deterministic interleavings.
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'
import { mkdirSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import type { DB } from '../app/types/db'
import {
  partitionMigrationNames,
  rebuildBaselineUrl,
} from '../db/rebuild-baseline.mjs'

mkdirSync(new URL('../../.wrangler/integration-logs', import.meta.url), {
  recursive: true,
})
process.env.WRANGLER_LOG_PATH = new URL(
  '../../.wrangler/integration-logs',
  import.meta.url,
).pathname
const { createTestHarness, unstable_readConfig, unstable_splitSqlQuery } =
  await import('wrangler')

const BETTER_AUTH_SECRET = 'integration-test-only-'.repeat(3)
const productionConfigUrl = new URL(
  '../build/server/wrangler.json',
  import.meta.url,
)
const integrationConfigUrl = new URL(
  '../build/server/wrangler.bot-members-integration.json',
  import.meta.url,
)
function disableRemoteBindings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(disableRemoteBindings)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'remote' && child === true ? false : disableRemoteBindings(child),
    ]),
  )
}
const productionConfig = JSON.parse(
  await readFile(productionConfigUrl, 'utf8'),
) as Record<string, unknown>
delete productionConfig.configPath
delete productionConfig.userConfigPath
delete productionConfig.flagship
await writeFile(
  integrationConfigUrl,
  JSON.stringify(disableRemoteBindings(productionConfig)),
)
const publicIntegration = process.env.PUBLIC_INTEGRATION === '1'
const sandboxName = unstable_readConfig(
  {
    config: new URL('../wrangler.sandbox.jsonc', import.meta.url).pathname,
    ...(publicIntegration ? {} : { env: 'production' }),
  },
  { hideWarnings: true },
).name
const harness = createTestHarness({
  root: new URL('..', import.meta.url).pathname,
  workers: [
    {
      configPath: 'build/server/wrangler.bot-members-integration.json',
      vars: {
        APP_ENV: 'development',
        INTEGRATION_TEST: 'true',
        BETTER_AUTH_URL: 'http://localhost',
        DEFAULT_LOCALE: 'en',
        D1_BACKUP_ACCOUNT_ID: 'test-account',
        D1_BACKUP_DATABASE_ID: 'test-database',
      },
      secrets: {
        BETTER_AUTH_SECRET,
        D1_REST_API_TOKEN: 'test-token',
        STRIPE_SECRET_KEY: ['sk', 'test', 'integration'].join('_'),
        STRIPE_WEBHOOK_SECRET: ['whsec', 'integration'].join('_'),
      },
    },
    {
      configPath: 'wrangler.og-image.jsonc',
      ...(publicIntegration ? {} : { env: 'production' }),
    },
    {
      configPath: 'wrangler.alerts.jsonc',
      ...(publicIntegration ? {} : { env: 'production' }),
    },
    {
      configPath: 'wrangler.sandbox.jsonc',
      ...(publicIntegration ? {} : { env: 'production' }),
      vars: { APP_ENV: 'development' },
      secrets: { BETTER_AUTH_SECRET },
    },
  ],
})
if (typeof productionConfig.name !== 'string')
  throw new Error('Main Worker config is missing its name')
const worker = harness.getWorker(productionConfig.name)
if (!sandboxName) throw new Error('Sandbox Worker config is missing its name')

// The services under test read env.DB through 'cloudflare:workers'. Point
// that import at the harness's real D1 binding, wrapped so a test can inject
// a deterministic interleaving right before a batch commits.
const envRef = vi.hoisted(() => ({
  db: null as unknown,
  beforeNextBatch: null as (() => Promise<void> | void) | null,
}))
vi.mock('cloudflare:workers', () => ({
  env: {
    get DB() {
      const real = envRef.db as {
        prepare: (sql: string) => unknown
        batch: (statements: unknown[]) => Promise<unknown>
      }
      if (!real) throw new Error('DB binding not initialized')
      return {
        prepare: (sql: string) => real.prepare(sql),
        batch: async (statements: unknown[]) => {
          const hook = envRef.beforeNextBatch
          envRef.beforeNextBatch = null
          if (hook) await hook()
          return await real.batch(statements)
        },
      }
    },
  },
}))

const { createWorkspaceBot, reissueWorkspaceBotCredential, stopWorkspaceBot } =
  await import('../app/services/bot-members.server')
const { refreshCliSession } =
  await import('../app/services/cli-refresh-credentials.server')

async function applyProductionD1Schema() {
  const env = await worker.getEnv<{ DB: D1Database }>()
  const baseline = await readFile(rebuildBaselineUrl, 'utf8')
  await env.DB.batch(
    unstable_splitSqlQuery(baseline).map((sql) => env.DB.prepare(sql)),
  )
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS d1_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
    )`,
  ).run()
  const { baselineAndEarlier: migrationNames } = partitionMigrationNames(
    await readdir(new URL('../db/migrations', import.meta.url)),
  )
  await env.DB.batch(
    migrationNames.map((name) =>
      env.DB.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(name),
    ),
  )
  await worker.applyD1Migrations('DB')
}

const NOW = '2026-08-01T00:00:00.000Z'
const ADMIN = { id: 'admin1', workspaceId: 'ws1' }

let rawDb: D1Database
let db: Kysely<DB>

async function seedWorkspaceFixture(plan = 'team') {
  await rawDb.batch([
    rawDb
      .prepare(
        `INSERT INTO workspaces (
          id, hd, name, created_at, plan, storage_quota_bytes,
          self_upload_enabled, storage_used_bytes, storage_updated_at
        ) VALUES ('ws1', 'example.com', 'Example', ?, ?, 104857600, 1, 0, ?)`,
      )
      .bind(NOW, plan, NOW),
    rawDb
      .prepare(
        `INSERT INTO users (
          id, email, email_verified, name, created_at, updated_at, workspace_id
        ) VALUES ('admin1', 'admin@example.com', 1, 'Admin', ?, ?, 'ws1')`,
      )
      .bind(NOW, NOW),
    rawDb
      .prepare(
        `INSERT INTO workspace_members (
          workspace_id, user_id, role, status, created_at, updated_at
        ) VALUES ('ws1', 'admin1', 'owner', 'active', ?, ?)`,
      )
      .bind(NOW, NOW),
    rawDb
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, created_by_id, name, created_at, updated_at
        ) VALUES ('proj1', 'ws1', 'project', 'admin1', 'Bot project', ?, ?)`,
      )
      .bind(NOW, NOW),
  ])
}

async function tableCounts(botUserId: string) {
  const [users, members, profiles, families, credentials, sessions, audits] =
    await Promise.all([
      rawDb
        .prepare('SELECT COUNT(*) AS c FROM users WHERE id = ?')
        .bind(botUserId)
        .first<{ c: number }>(),
      rawDb
        .prepare(
          'SELECT COUNT(*) AS c FROM workspace_members WHERE user_id = ?',
        )
        .bind(botUserId)
        .first<{ c: number }>(),
      rawDb
        .prepare('SELECT COUNT(*) AS c FROM agent_profiles WHERE user_id = ?')
        .bind(botUserId)
        .first<{ c: number }>(),
      rawDb
        .prepare(
          'SELECT COUNT(*) AS c FROM cli_family_authorities WHERE user_id = ?',
        )
        .bind(botUserId)
        .first<{ c: number }>(),
      rawDb
        .prepare(
          'SELECT COUNT(*) AS c FROM cli_refresh_credentials WHERE user_id = ?',
        )
        .bind(botUserId)
        .first<{ c: number }>(),
      rawDb
        .prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?')
        .bind(botUserId)
        .first<{ c: number }>(),
      rawDb
        .prepare('SELECT COUNT(*) AS c FROM audit_events WHERE subject_id = ?')
        .bind(botUserId)
        .first<{ c: number }>(),
    ])
  return {
    users: users?.c ?? 0,
    members: members?.c ?? 0,
    profiles: profiles?.c ?? 0,
    families: families?.c ?? 0,
    credentials: credentials?.c ?? 0,
    sessions: sessions?.c ?? 0,
    audits: audits?.c ?? 0,
  }
}

beforeAll(async () => {
  await harness.listen()
})

beforeEach(async () => {
  await applyProductionD1Schema()
  const env = await worker.getEnv<{ DB: D1Database }>()
  rawDb = env.DB
  envRef.db = env.DB
  envRef.beforeNextBatch = null
  db = new Kysely<DB>({ dialect: new D1Dialect({ database: env.DB }) })
  await seedWorkspaceFixture()
})

afterEach(async (context) => {
  if (context.task.result?.state === 'fail') {
    await harness.debug()
  }
  envRef.db = null
  await harness.reset()
})

afterAll(async () => {
  await harness.close()
})

describe('bot member lifecycle on real D1', () => {
  test('create/create: the unique-name loser rolls back with zero partial state', async () => {
    const first = await createWorkspaceBot(db, ADMIN, {
      name: 'Deploy',
      projectId: 'proj1',
    })
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return

    const before = await rawDb
      .prepare("SELECT COUNT(*) AS c FROM users WHERE kind = 'bot'")
      .first<{ c: number }>()
    const loser = await createWorkspaceBot(db, ADMIN, {
      name: 'Deploy',
      projectId: 'proj1',
    })
    expect(loser.kind).toBe('bot-name-invalid')
    const after = await rawDb
      .prepare("SELECT COUNT(*) AS c FROM users WHERE kind = 'bot'")
      .first<{ c: number }>()
    expect(after?.c).toBe(before?.c)
    // The rolled-back attempt left no members, profiles, credentials, or
    // audits behind (only the winner's rows exist).
    const winner = await tableCounts(first.botUserId)
    expect(winner).toMatchObject({
      users: 1,
      members: 1,
      profiles: 1,
      families: 1,
      credentials: 1,
    })
    const orphanAudits = await rawDb
      .prepare(
        "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'bot.create'",
      )
      .first<{ c: number }>()
    expect(orphanAudits?.c).toBe(1)
  })

  test('concurrent-style same-name creates on the cap boundary never exceed the limit', async () => {
    await rawDb
      .prepare("UPDATE workspaces SET plan = 'free' WHERE id = 'ws1'")
      .run()
    const a = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot A',
      projectId: 'proj1',
    })
    expect(a.kind).toBe('ok')
    const b = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot B',
      projectId: 'proj1',
    })
    expect(b.kind).toBe('bot-limit-reached')
    const bots = await rawDb
      .prepare(
        "SELECT COUNT(*) AS c FROM users WHERE kind = 'bot' AND bot_stopped_at IS NULL",
      )
      .first<{ c: number }>()
    expect(bots?.c).toBe(1)
    // The rejected create must not leave an orphan audience grant either: the
    // grant insert is gated on the head users INSERT having landed.
    const grants = await rawDb
      .prepare(
        `SELECT COUNT(*) AS c FROM project_share_defaults psd
          WHERE psd.email LIKE '%@bots.artifactshare.invalid'
            AND NOT EXISTS (
              SELECT 1 FROM users u WHERE lower(u.email) = lower(psd.email)
            )`,
      )
      .first<{ c: number }>()
    expect(grants?.c).toBe(0)
  })

  test('creation race window: an archived destination is reclaimed via the stop path', async () => {
    envRef.beforeNextBatch = async () => {
      // The destination is archived after the pre-check but before the batch.
      await rawDb
        .prepare(
          "UPDATE artifact_containers SET archived_at = '2026-08-01T00:00:01.000Z' WHERE id = 'proj1'",
        )
        .run()
    }
    const result = await createWorkspaceBot(db, ADMIN, {
      name: 'Doomed',
      projectId: 'proj1',
    })
    expect(result.kind).toBe('bot-destination-invalid')
    // Defined outcome: bot.create and bot.stop remain as a pair, the stopped
    // bot row stays, and it cannot authenticate (no active family).
    const audits = await rawDb
      .prepare(
        "SELECT action, COUNT(*) AS c FROM audit_events WHERE action IN ('bot.create','bot.stop') GROUP BY action",
      )
      .all<{ action: string; c: number }>()
    expect(
      Object.fromEntries(audits.results.map((row) => [row.action, row.c])),
    ).toEqual({ 'bot.create': 1, 'bot.stop': 1 })
    const bot = await rawDb
      .prepare("SELECT bot_stopped_at FROM users WHERE kind = 'bot'")
      .first<{ bot_stopped_at: string | null }>()
    expect(bot?.bot_stopped_at).not.toBeNull()
    const activeFamilies = await rawDb
      .prepare(
        "SELECT COUNT(*) AS c FROM cli_family_authorities WHERE status = 'active'",
      )
      .first<{ c: number }>()
    expect(activeFamilies?.c).toBe(0)
    // A reclaimed (stopped) bot does not count against the cap.
    await rawDb
      .prepare(
        "UPDATE artifact_containers SET archived_at = NULL WHERE id = 'proj1'",
      )
      .run()
    const retry = await createWorkspaceBot(db, ADMIN, {
      name: 'Doomed',
      projectId: 'proj1',
    })
    expect(retry.kind).toBe('ok')
  })

  test('stop/stop is idempotent with one bot.stop audit; stop executes the full teardown', async () => {
    const created = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    // Give the bot a live session as a rotation would.
    const refreshed = await refreshCliSession(
      db,
      created.token,
      'rotation-1',
      BETTER_AUTH_SECRET,
    )
    expect(refreshed.kind).toBe('ok')

    const first = await stopWorkspaceBot(db, ADMIN, created.botUserId)
    expect(first.kind).toBe('ok')
    const second = await stopWorkspaceBot(db, ADMIN, created.botUserId)
    expect(second.kind).toBe('ok')

    const stopAudits = await rawDb
      .prepare(
        "SELECT COUNT(*) AS c FROM audit_events WHERE action = 'bot.stop'",
      )
      .first<{ c: number }>()
    expect(stopAudits?.c).toBe(1)
    const state = await tableCounts(created.botUserId)
    expect(state.sessions).toBe(0)
    const liveCredentials = await rawDb
      .prepare(
        'SELECT COUNT(*) AS c FROM cli_refresh_credentials WHERE user_id = ? AND revoked_at IS NULL',
      )
      .bind(created.botUserId)
      .first<{ c: number }>()
    expect(liveCredentials?.c).toBe(0)
    const member = await rawDb
      .prepare('SELECT status FROM workspace_members WHERE user_id = ?')
      .bind(created.botUserId)
      .first<{ status: string }>()
    expect(member?.status).toBe('removed')
  })

  test('stop/reissue: the stop wins and the reissue reports bot-stopped without new credentials', async () => {
    const created = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return

    envRef.beforeNextBatch = async () => {
      const stop = await stopWorkspaceBot(db, ADMIN, created.botUserId)
      expect(stop.kind).toBe('ok')
    }
    const reissue = await reissueWorkspaceBotCredential(
      db,
      ADMIN,
      created.botUserId,
    )
    expect(reissue.kind).toBe('bot-stopped')
    const credentials = await rawDb
      .prepare(
        'SELECT COUNT(*) AS c FROM cli_refresh_credentials WHERE user_id = ? AND revoked_at IS NULL',
      )
      .bind(created.botUserId)
      .first<{ c: number }>()
    expect(credentials?.c).toBe(0)
    const activeFamilies = await rawDb
      .prepare(
        "SELECT COUNT(*) AS c FROM cli_family_authorities WHERE user_id = ? AND status = 'active'",
      )
      .bind(created.botUserId)
      .first<{ c: number }>()
    expect(activeFamilies?.c).toBe(0)
  })

  test('refresh pre-read then stop commit: no session or credential rows are created', async () => {
    const created = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return

    envRef.beforeNextBatch = async () => {
      const stop = await stopWorkspaceBot(db, ADMIN, created.botUserId)
      expect(stop.kind).toBe('ok')
    }
    const refreshed = await refreshCliSession(
      db,
      created.token,
      'rotation-race',
      BETTER_AUTH_SECRET,
    )
    expect(refreshed).toEqual({ kind: 'invalid' })
    const state = await tableCounts(created.botUserId)
    expect(state.sessions).toBe(0)
    const liveCredentials = await rawDb
      .prepare(
        'SELECT COUNT(*) AS c FROM cli_refresh_credentials WHERE user_id = ? AND revoked_at IS NULL',
      )
      .bind(created.botUserId)
      .first<{ c: number }>()
    expect(liveCredentials?.c).toBe(0)
  })

  test('rotation replay after stop fails: the stop deleted the replay session', async () => {
    const created = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    const rotated = await refreshCliSession(
      db,
      created.token,
      'rotation-replayed',
      BETTER_AUTH_SECRET,
    )
    expect(rotated.kind).toBe('ok')
    const stop = await stopWorkspaceBot(db, ADMIN, created.botUserId)
    expect(stop.kind).toBe('ok')
    // Replaying the consumed token + same rotation id must not resurrect a
    // session: the stop deleted the rotation session row (this guarantee
    // depends on hard-deleting sessions in the stop batch).
    const replay = await refreshCliSession(
      db,
      created.token,
      'rotation-replayed',
      BETTER_AUTH_SECRET,
    )
    expect(replay).toEqual({ kind: 'invalid' })
    const sessions = await tableCounts(created.botUserId)
    expect(sessions.sessions).toBe(0)
  })

  test('legacy refresh after stop creates no session or credential rows', async () => {
    const created = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    await stopWorkspaceBot(db, ADMIN, created.botUserId)
    const legacy = await refreshCliSession(
      db,
      created.token,
      null,
      BETTER_AUTH_SECRET,
    )
    expect(legacy).toEqual({ kind: 'invalid' })
    const state = await tableCounts(created.botUserId)
    expect(state.sessions).toBe(0)
  })

  test('grant pre-read → stop commit → grant write: the grant does not come back', async () => {
    const { saveProjectShareDefaults } =
      await import('../app/services/projects.server')
    const created = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return

    envRef.beforeNextBatch = async () => {
      const stop = await stopWorkspaceBot(db, ADMIN, created.botUserId)
      expect(stop.kind).toBe('ok')
    }
    const result = await saveProjectShareDefaults(
      db,
      'ws1',
      'proj1',
      'admin1',
      {
        addEntries: [{ email: created.email, role: 'contributor' }],
      },
    )
    expect(result).toBe('bot-stopped-grant-rejected')
    const grants = await rawDb
      .prepare(
        'SELECT COUNT(*) AS c FROM project_share_defaults WHERE email = ?',
      )
      .bind(created.email)
      .first<{ c: number }>()
    expect(grants?.c).toBe(0)
  })

  test('mixed bulk save (bot + human) is all-or-nothing when a stop wins the race', async () => {
    const { saveProjectShareDefaults } =
      await import('../app/services/projects.server')
    const botA = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot A',
      projectId: 'proj1',
    })
    const botB = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot B',
      projectId: 'proj1',
    })
    expect(botA.kind).toBe('ok')
    expect(botB.kind).toBe('ok')
    if (botA.kind !== 'ok' || botB.kind !== 'ok') return
    // Pre-existing grants: bot B (viewer) gets a role change and a human
    // grant gets removed in the same save that adds bot A and a new human.
    await rawDb.batch([
      rawDb
        .prepare(
          `INSERT INTO project_share_defaults (
            id, project_container_id, email, role, display_name,
            created_by_id, created_at, updated_at
          ) VALUES ('psd-botb', 'proj1', ?, 'viewer', NULL, 'admin1', ?, ?)`,
        )
        .bind(botB.email, NOW, NOW),
      rawDb
        .prepare(
          `INSERT INTO project_share_defaults (
            id, project_container_id, email, role, display_name,
            created_by_id, created_at, updated_at
          ) VALUES ('psd-human', 'proj1', 'human@example.com', 'viewer', NULL, 'admin1', ?, ?)`,
        )
        .bind(NOW, NOW),
    ])

    envRef.beforeNextBatch = async () => {
      const stop = await stopWorkspaceBot(db, ADMIN, botA.botUserId)
      expect(stop.kind).toBe('ok')
    }
    const result = await saveProjectShareDefaults(
      db,
      'ws1',
      'proj1',
      'admin1',
      {
        addEntries: [{ email: botA.email, role: 'contributor' }],
        addEmails: ['newhuman@example.com'],
        roleChanges: [{ email: botB.email, role: 'contributor' }],
        removeEmails: ['human@example.com'],
      },
    )
    expect(result).toBe('bot-stopped-grant-rejected')
    // Nothing in the batch landed: no bot A grant, no new human grant, the
    // human removal did not apply, and bot B's suppressed role change (row
    // still present with the old role) was not misreported as success.
    const rows = await rawDb
      .prepare(
        "SELECT email, role FROM project_share_defaults WHERE project_container_id = 'proj1'",
      )
      .all<{ email: string; role: string }>()
    expect(
      Object.fromEntries(rows.results.map((row) => [row.email, row.role])),
    ).toEqual({
      'human@example.com': 'viewer',
      [botB.email]: 'viewer',
    })
  })

  test('reissue supersedes the old family; only the last reissue token works', async () => {
    const created = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    const reissueA = await reissueWorkspaceBotCredential(
      db,
      ADMIN,
      created.botUserId,
    )
    expect(reissueA.kind).toBe('ok')
    const reissueB = await reissueWorkspaceBotCredential(
      db,
      ADMIN,
      created.botUserId,
    )
    expect(reissueB.kind).toBe('ok')
    if (reissueA.kind !== 'ok' || reissueB.kind !== 'ok') return

    const activeFamilies = await rawDb
      .prepare(
        "SELECT COUNT(*) AS c FROM cli_family_authorities WHERE user_id = ? AND status = 'active'",
      )
      .bind(created.botUserId)
      .first<{ c: number }>()
    expect(activeFamilies?.c).toBe(1)

    // The earlier reissue's token was revoked immediately even though unused.
    const oldToken = await refreshCliSession(
      db,
      reissueA.token,
      'rotation-a',
      BETTER_AUTH_SECRET,
    )
    expect(oldToken).toEqual({ kind: 'invalid' })
    const newToken = await refreshCliSession(
      db,
      reissueB.token,
      'rotation-b',
      BETTER_AUTH_SECRET,
    )
    expect(newToken.kind).toBe('ok')
  })
})
