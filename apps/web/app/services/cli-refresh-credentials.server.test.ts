import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createD1BatchDbMock } from '~/test/d1-batch-mock'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  beforeNextBatch: null as (() => void | Promise<void>) | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1BatchDbMock({ sqlite: sqliteRef }) },
}))
import {
  cleanupExpiredCliRotationReplays,
  issueCliRefreshCredential,
  listCliRefreshCredentialFamilies,
  refreshCliSession,
  revokeAllCliRefreshCredentialFamilies,
  revokeAllCliRefreshCredentialFamiliesForMember,
  revokeCliRefreshCredential,
  revokeCliRefreshCredentialFamily,
} from './cli-refresh-credentials.server'

describe('cli-refresh-credentials service', () => {
  const secret = 'test-secret-with-enough-entropy'
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    sqliteRef.current = sqlite
    db = fixture.db
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
    sqliteRef.beforeNextBatch = null
  })

  test('issues a refresh credential and stores only a hash', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const row = readRefreshRow(sqlite)

    expect(issued.refreshToken).toMatch(/^asr_/)
    expect(row.token_hash).not.toBe(issued.refreshToken)
    expect(row.token_hash).toHaveLength(64)
    expect(row.user_id).toBe('u1')
    expect(row.last_used_at).toBeNull()
    expect(row.revoked_at).toBeNull()
  })

  test('links the device-login session at credential issuance for logout revocation', async () => {
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
         ) VALUES (
           'device-session', 'u1', 'device-session-token', '2099-01-01T00:00:00.000Z',
           NULL, 'artifactshare-cli-device', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
         )`,
      )
      .run()

    const issued = await issueCliRefreshCredential(
      db,
      'u1',
      'device-session-token',
    )
    expect(issued).not.toBeNull()
    if (!issued) return
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM cli_refresh_sessions')
        .get(),
    ).toEqual({ count: 1 })

    expect(await revokeCliRefreshCredential(db, issued.refreshToken)).toBe('ok')
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({
      count: 0,
    })
  })

  test('allows a device session to issue again after a lost response', async () => {
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
         ) VALUES (
           'retry-session', 'u1', 'retry-session-token', '2099-01-01T00:00:00.000Z',
           NULL, 'artifactshare-cli-device', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
         )`,
      )
      .run()

    const lost = await issueCliRefreshCredential(
      db,
      'u1',
      'retry-session-token',
    )
    const replacement = await issueCliRefreshCredential(
      db,
      'u1',
      'retry-session-token',
    )
    expect(lost).not.toBeNull()
    expect(replacement).not.toBeNull()
    if (!lost || !replacement) return

    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM cli_refresh_sessions')
        .get(),
    ).toEqual({ count: 2 })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM cli_refresh_credentials
           WHERE revoked_at IS NULL`,
        )
        .get(),
    ).toEqual({ count: 1 })
    expect(
      await refreshCliSession(db, lost.refreshToken, 'lost-response', secret),
    ).toEqual({ kind: 'invalid' })
    expect(
      await refreshCliSession(
        db,
        replacement.refreshToken,
        'replacement-response',
        secret,
      ),
    ).toMatchObject({ kind: 'ok' })
  })

  test('does not issue a CLI credential from an ordinary browser session', async () => {
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
         ) VALUES (
           'browser-source', 'u1', 'browser-source-token', '2099-01-01T00:00:00.000Z',
           NULL, 'Mozilla/5.0', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
         )`,
      )
      .run()

    expect(
      await issueCliRefreshCredential(db, 'u1', 'browser-source-token'),
    ).toBeNull()
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM cli_refresh_credentials')
        .get(),
    ).toEqual({ count: 0 })
  })

  test('refreshes a session and records last use', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const result = await refreshCliSession(
      db,
      issued.refreshToken,
      'rotation-1',
      secret,
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.sessionToken).toMatch(/^ass_/)

    const session = sqlite
      .prepare(`SELECT user_id, token, expires_at FROM sessions`)
      .get() as { user_id: string; token: string; expires_at: string }
    expect(session).toEqual({
      user_id: 'u1',
      token: result.sessionToken,
      expires_at: result.sessionExpiresAt,
    })
    expect(readRefreshRow(sqlite).last_used_at).not.toBeNull()
  })

  test('keeps the pre-rotation request shape working during CLI rollout', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const result = await refreshCliSession(
      db,
      issued.refreshToken,
      null,
      secret,
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.refreshToken).toBe(issued.refreshToken)
    expect(
      sqlite
        .prepare(
          `SELECT action FROM audit_events
           WHERE action = 'cli.refresh_credential.use_legacy'`,
        )
        .get(),
    ).toEqual({ action: 'cli.refresh_credential.use_legacy' })
  })

  test('rejects the legacy request shape after a family has rotated', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const rotated = await refreshCliSession(
      db,
      issued.refreshToken,
      'upgrade-to-rotation',
      secret,
    )
    expect(rotated.kind).toBe('ok')
    if (rotated.kind !== 'ok') return

    expect(
      await refreshCliSession(db, rotated.refreshToken, null, secret),
    ).toEqual({ kind: 'invalid' })
  })

  test('rejects unknown expired and revoked refresh credentials', async () => {
    expect(
      await refreshCliSession(db, 'asr_unknown', 'unknown', secret),
    ).toEqual({
      kind: 'invalid',
    })

    const expired = await issueCliRefreshCredential(db, 'u1')
    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials
         SET expires_at = '2000-01-01T00:00:00.000Z'`,
      )
      .run()
    expect(
      await refreshCliSession(db, expired.refreshToken, 'expired', secret),
    ).toEqual({
      kind: 'invalid',
    })

    sqlite.prepare(`DELETE FROM cli_refresh_credentials`).run()
    const revoked = await issueCliRefreshCredential(db, 'u1')
    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials
         SET revoked_at = '2026-06-21T00:00:00.000Z'`,
      )
      .run()
    expect(
      await refreshCliSession(db, revoked.refreshToken, 'revoked', secret),
    ).toEqual({
      kind: 'invalid',
    })
  })

  test('refresh credential re-issues a session against the current workspace', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes,
        storage_updated_at
      ) VALUES (
        'ws-personal', NULL, 'Personal', '2026-05-26T00:00:00.000Z', 'free',
        104857600, 0, '2026-05-26T00:00:00.000Z'
      );
      UPDATE users SET workspace_id = 'ws-personal' WHERE id = 'u1';
      DELETE FROM sessions;
    `)

    const result = await refreshCliSession(
      db,
      issued.refreshToken,
      'rotation-2',
      secret,
    )

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return

    const session = sqlite
      .prepare(`SELECT user_id, token FROM sessions`)
      .get() as { user_id: string; token: string }
    expect(session).toEqual({
      user_id: 'u1',
      token: result.sessionToken,
    })
    expect(
      (
        sqlite
          .prepare(`SELECT workspace_id FROM users WHERE id = 'u1'`)
          .get() as { workspace_id: string }
      ).workspace_id,
    ).toBe('ws-personal')
  })

  test('replays one rotation idempotently and rejects a different rotation id', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const first = await refreshCliSession(
      db,
      issued.refreshToken,
      'stable-request',
      secret,
    )
    const replay = await refreshCliSession(
      db,
      issued.refreshToken,
      'stable-request',
      secret,
    )
    const different = await refreshCliSession(
      db,
      issued.refreshToken,
      'different-request',
      secret,
    )

    expect(first.kind).toBe('ok')
    expect(replay).toEqual(first)
    expect(different).toEqual({ kind: 'invalid' })
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM cli_refresh_credentials')
        .get(),
    ).toEqual({ count: 2 })
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 1 })
  })

  test('clears expired replay material without breaking lineage or revocation', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const rotated = await refreshCliSession(
      db,
      issued.refreshToken,
      'cleanup-request',
      secret,
    )
    expect(rotated.kind).toBe('ok')
    if (rotated.kind !== 'ok') return

    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials
         SET rotation_retry_until = '2026-08-09T00:00:00.000Z'
         WHERE replaced_by_id IS NOT NULL`,
      )
      .run()

    await expect(
      cleanupExpiredCliRotationReplays(db, '2026-08-09T00:00:01.000Z'),
    ).resolves.toBe(1)
    await expect(
      cleanupExpiredCliRotationReplays(db, '2026-08-09T00:00:02.000Z'),
    ).resolves.toBe(0)

    const old = sqlite
      .prepare(
        `SELECT family_id, replaced_by_id, rotation_request_hash,
                rotation_retry_until, rotation_session_id
         FROM cli_refresh_credentials
         WHERE replaced_by_id IS NOT NULL`,
      )
      .get() as Record<string, string | null>
    expect(old.family_id).not.toBeNull()
    expect(old.replaced_by_id).not.toBeNull()
    expect(old.rotation_request_hash).toBeNull()
    expect(old.rotation_retry_until).toBeNull()
    expect(old.rotation_session_id).toBeNull()
    expect(
      await refreshCliSession(
        db,
        issued.refreshToken,
        'cleanup-request',
        secret,
      ),
    ).toEqual({ kind: 'invalid' })
    expect(await revokeCliRefreshCredential(db, rotated.refreshToken)).toBe(
      'ok',
    )
  })

  test('keeps live and incomplete replay rows fail closed', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const rotated = await refreshCliSession(
      db,
      issued.refreshToken,
      'live-request',
      secret,
    )
    expect(rotated.kind).toBe('ok')
    if (rotated.kind !== 'ok') return

    await expect(
      cleanupExpiredCliRotationReplays(db, '2000-01-01T00:00:00.000Z'),
    ).resolves.toBe(0)
    expect(
      await refreshCliSession(db, issued.refreshToken, 'live-request', secret),
    ).toEqual(rotated)

    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials
         SET rotation_retry_until = '2000-01-01T00:00:00.000Z',
             rotation_session_id = NULL
         WHERE replaced_by_id IS NOT NULL`,
      )
      .run()
    await expect(
      cleanupExpiredCliRotationReplays(db, '2026-08-09T00:00:00.000Z'),
    ).resolves.toBe(0)
    const incomplete = sqlite
      .prepare(
        `SELECT rotation_request_hash, rotation_retry_until
         FROM cli_refresh_credentials
         WHERE replaced_by_id IS NOT NULL`,
      )
      .get() as Record<string, string | null>
    expect(incomplete.rotation_request_hash).not.toBeNull()
    expect(incomplete.rotation_retry_until).not.toBeNull()
  })

  test('concurrent refreshes with one rotation id converge on one credential', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    let winner: Awaited<ReturnType<typeof refreshCliSession>> | undefined
    sqliteRef.beforeNextBatch = async () => {
      winner = await refreshCliSession(
        db,
        issued.refreshToken,
        'concurrent-request',
        secret,
      )
    }

    const raced = await refreshCliSession(
      db,
      issued.refreshToken,
      'concurrent-request',
      secret,
    )

    expect(raced).toEqual(winner)
    expect(raced.kind).toBe('ok')
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM cli_refresh_credentials')
        .get(),
    ).toEqual({ count: 2 })
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 1 })
  })

  test('revokes the active credential family and records lifecycle audit events', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const rotated = await refreshCliSession(
      db,
      issued.refreshToken,
      'rotation-for-revoke',
      secret,
    )
    expect(rotated.kind).toBe('ok')
    if (rotated.kind !== 'ok') return

    expect(await revokeCliRefreshCredential(db, issued.refreshToken)).toBe('ok')
    expect(
      await refreshCliSession(db, rotated.refreshToken, 'after-logout', secret),
    ).toEqual({ kind: 'invalid' })
    expect(
      sqlite
        .prepare(
          `SELECT COUNT(*) AS count
           FROM cli_refresh_credentials
           WHERE revoked_at IS NULL`,
        )
        .get(),
    ).toEqual({ count: 0 })
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({ count: 0 })
    expect(
      await refreshCliSession(
        db,
        issued.refreshToken,
        'rotation-for-revoke',
        secret,
      ),
    ).toEqual({ kind: 'invalid' })
    expect(
      sqlite
        .prepare(
          `SELECT action FROM audit_events
           WHERE subject_type = 'cli_refresh_credential'
           ORDER BY created_at, rowid`,
        )
        .all()
        .map((row) => row.action),
    ).toEqual([
      'cli.refresh_credential.issue',
      'cli.refresh_credential.rotate',
      'cli.refresh_credential.revoke',
    ])
  })

  test('revokes sessions minted by the legacy refresh path', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const refreshed = await refreshCliSession(
      db,
      issued.refreshToken,
      null,
      secret,
    )
    expect(refreshed.kind).toBe('ok')
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({
      count: 1,
    })

    expect(await revokeCliRefreshCredential(db, issued.refreshToken)).toBe('ok')
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({
      count: 0,
    })
  })

  test('revokes pre-link CLI sessions without revoking browser or other-family sessions', async () => {
    const first = await issueCliRefreshCredential(db, 'u1')
    const second = await issueCliRefreshCredential(db, 'u1')
    const secondSession = await refreshCliSession(
      db,
      second.refreshToken,
      'other-family',
      secret,
    )
    expect(secondSession.kind).toBe('ok')
    if (secondSession.kind !== 'ok') return

    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
         ) VALUES
           ('pre-link-cli', 'u1', 'ass_pre_link', '2099-01-01T00:00:00.000Z', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
           ('browser', 'u1', 'browser-session', '2099-01-01T00:00:00.000Z', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()

    expect(await revokeCliRefreshCredential(db, first.refreshToken)).toBe('ok')
    expect(
      sqlite.prepare('SELECT token FROM sessions ORDER BY token').all(),
    ).toEqual([
      { token: secondSession.sessionToken },
      { token: 'browser-session' },
    ])
  })

  test('fails closed when legacy data has a null family id', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    sqlite.prepare('UPDATE cli_refresh_credentials SET family_id = NULL').run()

    expect(await revokeCliRefreshCredential(db, issued.refreshToken)).toBe(
      'inconsistent',
    )
    expect(readRefreshRow(sqlite).revoked_at).toBeNull()
    expect(
      await refreshCliSession(db, issued.refreshToken, 'null-family', secret),
    ).toEqual({ kind: 'invalid' })
  })

  test('lists one row per active family', async () => {
    await issueCliRefreshCredential(db, 'u1')
    await issueCliRefreshCredential(db, 'u1')
    const families = readRefreshFamilies(sqlite)
    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials SET created_at = ?, last_used_at = ?
         WHERE family_id = ?`,
      )
      .run('2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', families[0])

    expect(await listCliRefreshCredentialFamilies(db, 'u1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          familyId: families[0],
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUsedAt: '2026-02-01T00:00:00.000Z',
        }),
        expect.objectContaining({ familyId: families[1] }),
      ]),
    )
  })

  test('revokes one family idempotently and audits only the mutation', async () => {
    await issueCliRefreshCredential(db, 'u1')
    await issueCliRefreshCredential(db, 'u1')
    const [familyId] = readRefreshFamilies(sqlite)

    await revokeCliRefreshCredentialFamily(db, 'u1', familyId!)
    await revokeCliRefreshCredentialFamily(db, 'u1', familyId!)

    expect(readActiveRefreshFamilies(sqlite)).toHaveLength(1)
    const audits = readCredentialRevokeAudits(sqlite)
    expect(audits).toHaveLength(1)
    expect(audits[0]).toMatchObject({
      actor_user_id: 'u1',
      subject_id: familyId,
    })
    expect(JSON.parse(audits[0]!.detail)).toEqual(
      expect.objectContaining({ reason: 'self', target_user_id: 'u1' }),
    )
  })

  test('revokes all of the current user families', async () => {
    await issueCliRefreshCredential(db, 'u1')
    await issueCliRefreshCredential(db, 'u1')

    await revokeAllCliRefreshCredentialFamilies(db, 'u1')

    expect(readActiveRefreshFamilies(sqlite)).toHaveLength(0)
    const audits = readCredentialRevokeAudits(sqlite)
    expect(audits).toHaveLength(2)
    for (const audit of audits) {
      expect(JSON.parse(audit.detail)).toEqual(
        expect.objectContaining({ reason: 'self_all', target_user_id: 'u1' }),
      )
    }
  })

  test('allows an admin to revoke a member but not an owner', async () => {
    seedUser(sqlite, 'u2')
    seedUser(sqlite, 'u3')
    sqlite.exec(`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES
        ('ws1', 'u1', 'admin', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('ws1', 'u2', 'member', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
        ('ws1', 'u3', 'owner', 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
    `)
    await issueCliRefreshCredential(db, 'u2')
    await issueCliRefreshCredential(db, 'u3')

    expect(
      await revokeAllCliRefreshCredentialFamiliesForMember(
        db,
        { id: 'u1', workspaceId: 'ws1' },
        'u2',
      ),
    ).toBe('ok')
    expect(
      await revokeAllCliRefreshCredentialFamiliesForMember(
        db,
        { id: 'u1', workspaceId: 'ws1' },
        'u3',
      ),
    ).toBe('not-found')
    expect(readActiveRefreshFamilies(sqlite, 'u2')).toHaveLength(0)
    expect(readActiveRefreshFamilies(sqlite, 'u3')).toHaveLength(1)
    expect(JSON.parse(readCredentialRevokeAudits(sqlite)[0]!.detail)).toEqual(
      expect.objectContaining({ reason: 'admin', target_user_id: 'u2' }),
    )
  })
})

function readRefreshFamilies(db: DatabaseSync, userId = 'u1'): string[] {
  return db
    .prepare(
      `SELECT DISTINCT family_id FROM cli_refresh_credentials
       WHERE user_id = ? AND family_id IS NOT NULL ORDER BY family_id`,
    )
    .all(userId)
    .map((row) => String(row.family_id))
}

function readActiveRefreshFamilies(db: DatabaseSync, userId = 'u1') {
  return db
    .prepare(
      `SELECT DISTINCT family_id FROM cli_refresh_credentials
       WHERE user_id = ? AND family_id IS NOT NULL AND revoked_at IS NULL`,
    )
    .all(userId)
}

function readCredentialRevokeAudits(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT actor_user_id, subject_id, detail FROM audit_events
       WHERE action = 'cli.refresh_credential.revoke' ORDER BY created_at, id`,
    )
    .all() as Array<{
    actor_user_id: string
    subject_id: string
    detail: string
  }>
}

function readRefreshRow(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT user_id, token_hash, last_used_at, revoked_at
       FROM cli_refresh_credentials`,
    )
    .get() as {
    user_id: string
    token_hash: string
    last_used_at: string | null
    revoked_at: string | null
  }
}
