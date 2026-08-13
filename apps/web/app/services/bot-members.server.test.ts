import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { BOT_TOKEN_PREFIX, BOT_EMAIL_DOMAIN } from '~/lib/bot-account'
import {
  createWorkspaceBot,
  listWorkspaceBots,
  reissueWorkspaceBotCredential,
  stopWorkspaceBot,
} from './bot-members.server'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1MockFromSqliteRef(sqliteRef) },
}))

const ADMIN = { id: 'admin1', workspaceId: 'ws1' }

let sqlite: DatabaseSync
let db: Kysely<DB>

function seedAdmin(id = 'admin1', role = 'owner') {
  seedUser(sqlite, id)
  sqlite
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
       VALUES ('ws1', ?, ?, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, role)
}

function seedProject(
  id: string,
  {
    visibility = 'workspace',
    archived = false,
    workspaceId = 'ws1',
  }: {
    visibility?: 'workspace' | 'private'
    archived?: boolean
    workspaceId?: string
  } = {},
) {
  sqlite
    .prepare(
      `INSERT INTO artifact_containers (
         id, workspace_id, kind, owner_user_id, created_by_id, name,
         archived_at, created_at, updated_at, base_visibility
       ) VALUES (?, ?, 'project', NULL, 'admin1', ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, workspaceId, `Project ${id}`, archived ? '2026-02-01T00:00:00.000Z' : null, visibility)
}

function auditRows(action: string) {
  return sqlite
    .prepare(
      `SELECT action, subject_id, detail FROM audit_events WHERE action = ? ORDER BY created_at`,
    )
    .all(action) as Array<{ action: string; subject_id: string; detail: string }>
}

beforeEach(() => {
  const created = createMigratedInMemoryDb()
  sqlite = created.sqlite
  db = created.db
  sqliteRef.current = sqlite
  seedWorkspace(sqlite)
  seedAdmin()
})

afterEach(async () => {
  await db.destroy()
  sqliteRef.current = null
})

describe('createWorkspaceBot', () => {
  test('creates the bot, member, profile, family, credential, and audit', async () => {
    seedProject('proj1')
    const result = await createWorkspaceBot(db, ADMIN, {
      name: '  Deploy bot ',
      projectId: 'proj1',
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.token.startsWith(BOT_TOKEN_PREFIX)).toBe(true)
    expect(result.email.endsWith(`@${BOT_EMAIL_DOMAIN}`)).toBe(true)
    // Lowercase local part.
    expect(result.email).toBe(result.email.toLowerCase())

    const user = sqlite
      .prepare(`SELECT * FROM users WHERE id = ?`)
      .get(result.botUserId) as Record<string, unknown>
    expect(user.kind).toBe('bot')
    expect(user.name).toBe('Deploy bot')
    expect(user.email_verified).toBe(1)
    expect(user.bot_stopped_at).toBeNull()

    const member = sqlite
      .prepare(
        `SELECT role, status FROM workspace_members WHERE user_id = ? AND workspace_id = 'ws1'`,
      )
      .get(result.botUserId) as Record<string, unknown>
    expect(member).toEqual({ role: 'member', status: 'active' })

    const authority = sqlite
      .prepare(
        `SELECT preset, status, project_id, project_name_snapshot FROM cli_family_authorities WHERE user_id = ?`,
      )
      .get(result.botUserId) as Record<string, unknown>
    expect(authority).toEqual({
      preset: 'agent',
      status: 'active',
      project_id: 'proj1',
      project_name_snapshot: 'Project proj1',
    })

    const credential = sqlite
      .prepare(
        `SELECT revoked_at FROM cli_refresh_credentials WHERE user_id = ?`,
      )
      .get(result.botUserId) as Record<string, unknown>
    expect(credential.revoked_at).toBeNull()

    const audits = auditRows('bot.create')
    expect(audits).toHaveLength(1)
    const detail = JSON.parse(audits[0]!.detail)
    expect(detail).toEqual({
      name: 'Deploy bot',
      project_id: 'proj1',
      project_name: 'Project proj1',
    })
    // No token, hash, or generated email in the audit detail.
    expect(audits[0]!.detail).not.toContain(result.token)
    expect(audits[0]!.detail).not.toContain(result.email)
  })

  test('adds a contributor grant for a private destination', async () => {
    seedProject('proj1', { visibility: 'private' })
    const result = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    const grant = sqlite
      .prepare(
        `SELECT role FROM project_share_defaults WHERE project_container_id = 'proj1' AND email = ?`,
      )
      .get(result.email) as Record<string, unknown>
    expect(grant).toEqual({ role: 'contributor' })
  })

  test('no grant for a workspace-visible destination', async () => {
    seedProject('proj1')
    const result = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(result.kind).toBe('ok')
    const grants = sqlite
      .prepare(`SELECT COUNT(*) AS c FROM project_share_defaults`)
      .get() as { c: number }
    expect(grants.c).toBe(0)
  })

  test('rejects non-admin actors', async () => {
    seedAdmin('member1', 'member')
    seedProject('proj1')
    const result = await createWorkspaceBot(
      db,
      { id: 'member1', workspaceId: 'ws1' },
      { name: 'Bot', projectId: 'proj1' },
    )
    expect(result.kind).toBe('forbidden')
  })

  test('rejects invalid names', async () => {
    seedProject('proj1')
    for (const name of ['', '   ', 'a'.repeat(31), 'bad\u200bname', 'bad\u0007name']) {
      const result = await createWorkspaceBot(db, ADMIN, {
        name,
        projectId: 'proj1',
      })
      expect(result.kind).toBe('bot-name-invalid')
    }
  })

  test('rejects archived, missing, and cross-workspace destinations', async () => {
    seedProject('archived', { archived: true })
    sqlite
      .prepare(
        `INSERT INTO workspaces (id, hd, name, created_at, plan, storage_quota_bytes)
         VALUES ('ws2', NULL, 'Other', '2026-01-01T00:00:00.000Z', 'team', 1)`,
      )
      .run()
    seedProject('foreign', { workspaceId: 'ws2' })
    for (const projectId of ['archived', 'missing', 'foreign']) {
      const result = await createWorkspaceBot(db, ADMIN, {
        name: 'Bot',
        projectId,
      })
      expect(result.kind).toBe('bot-destination-invalid')
    }
  })

  test('rejects a private destination at the audience limit', async () => {
    seedProject('proj1', { visibility: 'private' })
    const insert = sqlite.prepare(
      `INSERT INTO project_share_defaults (id, project_container_id, email, role, created_at, updated_at)
       VALUES (?, 'proj1', ?, 'viewer', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    for (let i = 0; i < 50; i++) insert.run(`g${i}`, `g${i}@example.com`)
    const result = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(result.kind).toBe('bot-destination-invalid')
  })

  test('enforces the free-plan cap of one active bot', async () => {
    seedProject('proj1')
    const first = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot A',
      projectId: 'proj1',
    })
    expect(first.kind).toBe('ok')
    const second = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot B',
      projectId: 'proj1',
    })
    expect(second.kind).toBe('bot-limit-reached')
  })

  test('a stopped bot frees the cap and its name', async () => {
    seedProject('proj1')
    const first = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot A',
      projectId: 'proj1',
    })
    expect(first.kind).toBe('ok')
    if (first.kind !== 'ok') return
    await stopWorkspaceBot(db, ADMIN, first.botUserId)
    const second = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot A',
      projectId: 'proj1',
    })
    expect(second.kind).toBe('ok')
  })

  test('duplicate active bot name reports bot-name-invalid', async () => {
    seedProject('proj1')
    const first = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot A',
      projectId: 'proj1',
    })
    expect(first.kind).toBe('ok')
    sqlite.prepare(`UPDATE workspaces SET plan = 'team' WHERE id = 'ws1'`).run()
    const second = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot A',
      projectId: 'proj1',
    })
    expect(second.kind).toBe('bot-name-invalid')
  })

  test('paid plans allow up to ten active bots', async () => {
    sqlite.prepare(`UPDATE workspaces SET plan = 'team' WHERE id = 'ws1'`).run()
    seedProject('proj1')
    for (let i = 0; i < 10; i++) {
      const result = await createWorkspaceBot(db, ADMIN, {
        name: `Bot ${i}`,
        projectId: 'proj1',
      })
      expect(result.kind).toBe('ok')
    }
    const over = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot 10',
      projectId: 'proj1',
    })
    expect(over.kind).toBe('bot-limit-reached')
  })
})

describe('stopWorkspaceBot', () => {
  async function createBot(projectId = 'proj1') {
    const result = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId,
    })
    if (result.kind !== 'ok') throw new Error(`create failed: ${result.kind}`)
    return result
  }

  test('revokes credentials, deletes sessions, removes membership and grants', async () => {
    seedProject('proj1', { visibility: 'private' })
    const bot = await createBot()
    // Simulate an issued CLI session.
    sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at)
         VALUES ('bs1', ?, 'ass_bot', '2099-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run(bot.botUserId)

    const result = await stopWorkspaceBot(db, ADMIN, bot.botUserId)
    expect(result.kind).toBe('ok')

    const user = sqlite
      .prepare(`SELECT bot_stopped_at FROM users WHERE id = ?`)
      .get(bot.botUserId) as { bot_stopped_at: string | null }
    expect(user.bot_stopped_at).not.toBeNull()

    const credential = sqlite
      .prepare(`SELECT revoked_at FROM cli_refresh_credentials WHERE user_id = ?`)
      .get(bot.botUserId) as { revoked_at: string | null }
    expect(credential.revoked_at).not.toBeNull()

    const sessions = sqlite
      .prepare(`SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?`)
      .get(bot.botUserId) as { c: number }
    expect(sessions.c).toBe(0)

    const authority = sqlite
      .prepare(`SELECT status FROM cli_family_authorities WHERE user_id = ?`)
      .get(bot.botUserId) as { status: string }
    expect(authority.status).toBe('revoked')

    const member = sqlite
      .prepare(
        `SELECT status, removed_by FROM workspace_members WHERE user_id = ?`,
      )
      .get(bot.botUserId) as { status: string; removed_by: string }
    expect(member.status).toBe('removed')
    expect(member.removed_by).toBe('admin1')

    const grants = sqlite
      .prepare(`SELECT COUNT(*) AS c FROM project_share_defaults WHERE email = ?`)
      .get(bot.email) as { c: number }
    expect(grants.c).toBe(0)

    expect(auditRows('bot.stop')).toHaveLength(1)
    expect(auditRows('cli.refresh_credential.revoke')).toHaveLength(1)
  })

  test('stop is idempotent: second stop writes nothing and keeps one audit', async () => {
    seedProject('proj1')
    const bot = await createBot()
    await stopWorkspaceBot(db, ADMIN, bot.botUserId)
    const stoppedAt = (
      sqlite
        .prepare(`SELECT bot_stopped_at FROM users WHERE id = ?`)
        .get(bot.botUserId) as { bot_stopped_at: string }
    ).bot_stopped_at
    const second = await stopWorkspaceBot(db, ADMIN, bot.botUserId)
    expect(second.kind).toBe('ok')
    const after = sqlite
      .prepare(`SELECT bot_stopped_at FROM users WHERE id = ?`)
      .get(bot.botUserId) as { bot_stopped_at: string }
    expect(after.bot_stopped_at).toBe(stoppedAt)
    expect(auditRows('bot.stop')).toHaveLength(1)
  })

  test('stopping a bot whose credentials all expired succeeds with bot.stop only', async () => {
    seedProject('proj1')
    const bot = await createBot()
    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials SET expires_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?`,
      )
      .run(bot.botUserId)
    const result = await stopWorkspaceBot(db, ADMIN, bot.botUserId)
    expect(result.kind).toBe('ok')
    expect(auditRows('bot.stop')).toHaveLength(1)
    expect(auditRows('cli.refresh_credential.revoke')).toHaveLength(0)
  })

  test('rejects humans and unknown users as not-found', async () => {
    seedUser(sqlite, 'human1')
    expect((await stopWorkspaceBot(db, ADMIN, 'human1')).kind).toBe('not-found')
    expect((await stopWorkspaceBot(db, ADMIN, 'nope')).kind).toBe('not-found')
  })
})

describe('reissueWorkspaceBotCredential', () => {
  async function createBot() {
    seedProject('proj1')
    const result = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    if (result.kind !== 'ok') throw new Error(`create failed: ${result.kind}`)
    return result
  }

  test('supersedes the old family, revokes the unused old token, keeps the profile', async () => {
    const bot = await createBot()
    const profileBefore = sqlite
      .prepare(`SELECT id FROM agent_profiles WHERE user_id = ?`)
      .get(bot.botUserId) as { id: string }

    const result = await reissueWorkspaceBotCredential(db, ADMIN, bot.botUserId)
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.token.startsWith(BOT_TOKEN_PREFIX)).toBe(true)
    expect(result.token).not.toBe(bot.token)

    const authorities = sqlite
      .prepare(
        `SELECT status, agent_profile_id FROM cli_family_authorities WHERE user_id = ? ORDER BY created_at`,
      )
      .all(bot.botUserId) as Array<{ status: string; agent_profile_id: string }>
    expect(authorities.map((a) => a.status).sort()).toEqual([
      'active',
      'superseded',
    ])
    for (const authority of authorities) {
      expect(authority.agent_profile_id).toBe(profileBefore.id)
    }

    const credentials = sqlite
      .prepare(
        `SELECT revoked_at FROM cli_refresh_credentials WHERE user_id = ? ORDER BY created_at`,
      )
      .all(bot.botUserId) as Array<{ revoked_at: string | null }>
    expect(credentials).toHaveLength(2)
    // Old credential revoked even though it was never used.
    expect(credentials.filter((c) => c.revoked_at === null)).toHaveLength(1)

    expect(auditRows('bot.credential.reissue')).toHaveLength(1)
  })

  test('exactly one active family after concurrent-style repeat reissues', async () => {
    const bot = await createBot()
    await reissueWorkspaceBotCredential(db, ADMIN, bot.botUserId)
    await reissueWorkspaceBotCredential(db, ADMIN, bot.botUserId)
    const active = sqlite
      .prepare(
        `SELECT COUNT(*) AS c FROM cli_family_authorities WHERE user_id = ? AND status = 'active'`,
      )
      .get(bot.botUserId) as { c: number }
    expect(active.c).toBe(1)
  })

  test('rejects stopped bots', async () => {
    const bot = await createBot()
    await stopWorkspaceBot(db, ADMIN, bot.botUserId)
    const result = await reissueWorkspaceBotCredential(db, ADMIN, bot.botUserId)
    expect(result.kind).toBe('bot-stopped')
  })

  test('rejects when the destination project was deleted', async () => {
    const bot = await createBot()
    // Project deletion detaches non-live authorities: emulate the detach.
    sqlite
      .prepare(
        `UPDATE cli_family_authorities SET project_id = NULL WHERE user_id = ?`,
      )
      .run(bot.botUserId)
    const result = await reissueWorkspaceBotCredential(db, ADMIN, bot.botUserId)
    expect(result.kind).toBe('bot-destination-invalid')
  })
})

describe('listWorkspaceBots', () => {
  test('reports status, destination, and auth-refresh time', async () => {
    seedProject('proj1')
    const created = await createWorkspaceBot(db, ADMIN, {
      name: 'Bot',
      projectId: 'proj1',
    })
    expect(created.kind).toBe('ok')
    if (created.kind !== 'ok') return
    const [bot] = await listWorkspaceBots(db, 'ws1')
    expect(bot).toMatchObject({
      id: created.botUserId,
      name: 'Bot',
      email: created.email,
      botStoppedAt: null,
      projectId: 'proj1',
      projectName: 'Project proj1',
      credentialLive: true,
    })

    // Expired credential → credentialLive false, bot still listed.
    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials SET expires_at = '2020-01-01T00:00:00.000Z'`,
      )
      .run()
    const [expired] = await listWorkspaceBots(db, 'ws1')
    expect(expired!.credentialLive).toBe(false)
    expect(expired!.botStoppedAt).toBeNull()

    await stopWorkspaceBot(db, ADMIN, created.botUserId)
    const [stopped] = await listWorkspaceBots(db, 'ws1')
    expect(stopped!.botStoppedAt).not.toBeNull()
  })
})
