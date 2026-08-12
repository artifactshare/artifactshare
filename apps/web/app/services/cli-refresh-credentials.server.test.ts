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
      'test laptop',
      'stable-device-id',
    )
    expect(issued).not.toBeNull()
    if (!issued) return
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM cli_refresh_sessions')
        .get(),
    ).toEqual({ count: 1 })
    expect(
      sqlite
        .prepare(
          `SELECT preset, status FROM cli_family_authorities
           WHERE family_id = (SELECT family_id FROM cli_refresh_credentials LIMIT 1)`,
        )
        .get(),
    ).toEqual({ preset: 'unrestricted', status: 'active' })
    expect(
      sqlite
        .prepare(
          "SELECT kind, preset, bearer_only FROM cli_session_authorities WHERE session_id = 'device-session'",
        )
        .get(),
    ).toEqual({ kind: 'family', preset: 'unrestricted', bearer_only: 1 })

    const rotated = await refreshCliSession(
      db,
      issued.refreshToken,
      'preserve-device-identity',
      secret,
    )
    expect(rotated.kind).toBe('ok')
    expect(
      sqlite
        .prepare(
          `SELECT device_name, device_id
           FROM cli_refresh_credentials
           WHERE replaced_by_id IS NULL`,
        )
        .get(),
    ).toEqual({ device_name: 'test laptop', device_id: 'stable-device-id' })

    if (rotated.kind !== 'ok') return
    expect(await revokeCliRefreshCredential(db, rotated.refreshToken)).toBe(
      'ok',
    )
    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM sessions').get(),
    ).toEqual({
      count: 0,
    })
  })

  test('promotes an agent bootstrap into the refresh family', async () => {
    sqlite
      .prepare(
        `INSERT INTO artifact_containers (
          id, workspace_id, kind, owner_user_id, created_by_id, name, created_at, updated_at
        ) VALUES ('project-1', 'ws1', 'project', 'u1', 'u1', 'Agent output',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO sessions (
          id, user_id, token, expires_at, user_agent, created_at, updated_at
        ) VALUES ('device-session', 'u1', 'device-session-token',
          '2099-01-01T00:00:00.000Z', 'artifactshare-cli-device',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
         VALUES ('agent-1', 'u1', 'ws1', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO cli_session_authorities (
          session_id, family_id, kind, preset, workspace_id, project_id,
          agent_profile_id, expires_at, bearer_only, created_at
        ) VALUES ('device-session', NULL, 'bootstrap', 'agent', 'ws1',
          'project-1', 'agent-1', '2099-01-01T00:00:00.000Z', 1,
          '2026-01-01T00:00:00.000Z')`,
      )
      .run()

    const issued = await issueCliRefreshCredential(
      db,
      'u1',
      'device-session-token',
      'Codex',
      'agent-device',
    )
    expect(issued).not.toBeNull()
    if (!issued) return
    expect(
      sqlite
        .prepare(
          `SELECT preset, workspace_id, project_id, project_name_snapshot,
                  agent_profile_id
             FROM cli_family_authorities`,
        )
        .get(),
    ).toEqual({
      preset: 'agent',
      workspace_id: 'ws1',
      project_id: 'project-1',
      project_name_snapshot: 'Agent output',
      agent_profile_id: 'agent-1',
    })

    const refreshed = await refreshCliSession(
      db,
      issued.refreshToken,
      'agent-refresh',
      secret,
    )
    expect(refreshed.kind).toBe('ok')
    expect(
      sqlite
        .prepare(
          `SELECT preset, workspace_id, project_id, agent_profile_id
             FROM cli_session_authorities
            WHERE kind = 'family'`,
        )
        .get(),
    ).toEqual({
      preset: 'agent',
      workspace_id: 'ws1',
      project_id: 'project-1',
      agent_profile_id: 'agent-1',
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
    ).toEqual({ count: 1 })
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

  test('re-login supersedes the prior family for the same stable device label', async () => {
    for (const [id, token] of [
      ['device-one', 'device-token-one'],
      ['device-two', 'device-token-two'],
    ]) {
      sqlite
        .prepare(
          `INSERT INTO sessions (
             id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
           ) VALUES (?, 'u1', ?, '2099-01-01T00:00:00.000Z', NULL,
             'artifactshare-cli-device', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z')`,
        )
        .run(id, token)
    }

    await issueCliRefreshCredential(
      db,
      'u1',
      'device-token-one',
      'stable-device',
      'stable-device-id',
    )
    await issueCliRefreshCredential(
      db,
      'u1',
      'device-token-two',
      'stable-device',
      'stable-device-id',
    )

    expect(readActiveRefreshFamilies(sqlite)).toHaveLength(1)
    expect(readCredentialRevokeAudits(sqlite)).toEqual([
      expect.objectContaining({
        detail: expect.stringContaining('re_login'),
      }),
    ])
    expect(
      sqlite
        .prepare(
          "SELECT token FROM sessions WHERE user_agent = 'artifactshare-cli-device'",
        )
        .all(),
    ).toEqual([{ token: 'device-token-two' }])
  })

  test('a non-device source cannot supersede an existing device family', async () => {
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
         ) VALUES
           ('device', 'u1', 'device-token', '2099-01-01T00:00:00.000Z', NULL,
             'artifactshare-cli-device', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z'),
           ('browser', 'u1', 'browser-token', '2099-01-01T00:00:00.000Z', NULL,
             'browser', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    await issueCliRefreshCredential(
      db,
      'u1',
      'device-token',
      'stable-device',
      'stable-device-id',
    )

    expect(
      await issueCliRefreshCredential(
        db,
        'u1',
        'browser-token',
        'stable-device',
        'stable-device-id',
      ),
    ).toBeNull()

    expect(readActiveRefreshFamilies(sqlite)).toHaveLength(1)
    expect(
      sqlite.prepare("SELECT id FROM sessions WHERE id = 'device'").get(),
    ).toEqual({ id: 'device' })
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
    expect(
      sqlite
        .prepare('SELECT COUNT(*) AS count FROM cli_family_authorities')
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
           WHERE action LIKE 'cli.refresh_credential.%'
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
           ('pending-device-login', 'u1', 'pending-device-login', '2099-01-01T00:00:00.000Z', NULL, 'artifactshare-cli-device', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
           ('browser', 'u1', 'browser-session', '2099-01-01T00:00:00.000Z', NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()

    expect(await revokeCliRefreshCredential(db, first.refreshToken)).toBe('ok')
    expect(
      sqlite.prepare('SELECT token FROM sessions ORDER BY token').all(),
    ).toEqual([
      { token: secondSession.sessionToken },
      { token: 'browser-session' },
      { token: 'pending-device-login' },
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
        `UPDATE cli_refresh_credentials SET created_at = ?, last_used_at = ?, device_name = ?
         WHERE family_id = ?`,
      )
      .run(
        '2026-01-01T00:00:00.000Z',
        '2026-02-01T00:00:00.000Z',
        'laptop (default)',
        families[0],
      )

    expect(await listCliRefreshCredentialFamilies(db, 'u1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          familyId: families[0],
          createdAt: '2026-01-01T00:00:00.000Z',
          lastUsedAt: '2026-02-01T00:00:00.000Z',
          deviceName: 'laptop (default)',
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
      subject_id: 'u1',
    })
    expect(JSON.parse(audits[0]!.detail)).toEqual(
      expect.objectContaining({ reason: 'self', target_user_id: 'u1' }),
    )
  })

  test('a foreign family id is a no-op', async () => {
    seedUser(sqlite, 'u2')
    await issueCliRefreshCredential(db, 'u2')
    const [familyId] = readRefreshFamilies(sqlite, 'u2')

    await revokeCliRefreshCredentialFamily(db, 'u1', familyId!)

    expect(readActiveRefreshFamilies(sqlite, 'u2')).toHaveLength(1)
    expect(readCredentialRevokeAudits(sqlite)).toHaveLength(0)
  })

  test('self revoke marks an expired family revoked and audits once', async () => {
    await issueCliRefreshCredential(db, 'u1')
    const [familyId] = readRefreshFamilies(sqlite)
    sqlite
      .prepare('UPDATE cli_refresh_credentials SET expires_at = ?')
      .run('2020-01-01T00:00:00.000Z')

    await revokeCliRefreshCredentialFamily(db, 'u1', familyId!)
    await revokeCliRefreshCredentialFamily(db, 'u1', familyId!)

    expect(readCredentialRevokeAudits(sqlite)).toHaveLength(1)
    expect(readActiveRefreshFamilies(sqlite)).toHaveLength(0)
  })

  test('revoking one listed family removes unattributable legacy sessions', async () => {
    await issueCliRefreshCredential(db, 'u1')
    const [familyId] = readRefreshFamilies(sqlite)
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
         ) VALUES ('legacy-other', 'u1', 'ass_legacy_other', '2099-01-01T00:00:00.000Z',
           NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()

    await revokeCliRefreshCredentialFamily(db, 'u1', familyId!)

    expect(sqlite.prepare('SELECT token FROM sessions').all()).toEqual([])
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

  test('revoke all marks expired siblings in an active family revoked', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    await refreshCliSession(db, issued.refreshToken, 'rotation', secret)
    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials
         SET expires_at = '2020-01-01T00:00:00.000Z', revoked_at = NULL
         WHERE replaced_by_id IS NOT NULL`,
      )
      .run()

    await revokeAllCliRefreshCredentialFamilies(db, 'u1')

    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM cli_refresh_credentials WHERE revoked_at IS NULL',
        )
        .get(),
    ).toEqual({ count: 0 })
  })

  test('revoke all deletes sessions linked to a superseded family', async () => {
    const old = await issueCliRefreshCredential(db, 'u1')
    const session = await refreshCliSession(
      db,
      old.refreshToken,
      'superseded-session',
      secret,
    )
    expect(session.kind).toBe('ok')
    const [oldFamilyId] = readRefreshFamilies(sqlite)
    sqlite
      .prepare(
        'UPDATE cli_refresh_credentials SET revoked_at = ? WHERE family_id = ?',
      )
      .run('2026-01-02T00:00:00.000Z', oldFamilyId)
    await issueCliRefreshCredential(db, 'u1')

    await revokeAllCliRefreshCredentialFamilies(db, 'u1')

    expect(
      sqlite
        .prepare("SELECT token FROM sessions WHERE token LIKE 'ass_%'")
        .all(),
    ).toEqual([])
  })

  test('lists and revokes a family while its access session is still live', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    sqlite
      .prepare("UPDATE cli_refresh_credentials SET device_name = 'test-cli'")
      .run()
    const session = await refreshCliSession(
      db,
      issued.refreshToken,
      'live-access-session',
      secret,
    )
    expect(session.kind).toBe('ok')
    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials
         SET expires_at = '2020-01-01T00:00:00.000Z', revoked_at = NULL`,
      )
      .run()
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
         ) VALUES ('pre-link-live', 'u1', 'ass_pre_link_live',
           '2099-01-01T00:00:00.000Z', NULL, NULL,
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()

    expect(await listCliRefreshCredentialFamilies(db, 'u1')).toEqual([
      expect.objectContaining({ deviceName: 'test-cli' }),
    ])

    await revokeAllCliRefreshCredentialFamilies(db, 'u1')

    expect(
      sqlite
        .prepare("SELECT token FROM sessions WHERE token LIKE 'ass_%'")
        .all(),
    ).toEqual([])
    expect(
      sqlite
        .prepare(
          'SELECT COUNT(*) AS count FROM cli_refresh_credentials WHERE revoked_at IS NULL',
        )
        .get(),
    ).toEqual({ count: 0 })
  })

  test('single-family revoke audits a family kept active only by a live session', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const session = await refreshCliSession(
      db,
      issued.refreshToken,
      'live-only-single',
      secret,
    )
    expect(session.kind).toBe('ok')
    const [familyId] = readRefreshFamilies(sqlite)
    sqlite
      .prepare(
        'UPDATE cli_refresh_credentials SET revoked_at = ? WHERE family_id = ?',
      )
      .run('2026-01-02T00:00:00.000Z', familyId)

    await revokeCliRefreshCredentialFamily(db, 'u1', familyId!)

    expect(readCredentialRevokeAudits(sqlite)).toHaveLength(1)
    expect(
      sqlite
        .prepare("SELECT token FROM sessions WHERE token LIKE 'ass_%'")
        .all(),
    ).toEqual([])
  })

  test('logout deletes a linked session after its family was revoked', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const session = await refreshCliSession(
      db,
      issued.refreshToken,
      'revoked-family-session',
      secret,
    )
    expect(session.kind).toBe('ok')
    const [familyId] = readRefreshFamilies(sqlite)
    sqlite
      .prepare(
        'UPDATE cli_refresh_credentials SET revoked_at = ? WHERE family_id = ?',
      )
      .run('2026-01-02T00:00:00.000Z', familyId)

    expect(await revokeCliRefreshCredential(db, issued.refreshToken)).toBe('ok')
    expect(
      sqlite
        .prepare("SELECT token FROM sessions WHERE token LIKE 'ass_%'")
        .all(),
    ).toEqual([])
  })

  test('replayed logout does not append duplicate audit rows', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')

    expect(await revokeCliRefreshCredential(db, issued.refreshToken)).toBe('ok')
    expect(await revokeCliRefreshCredential(db, issued.refreshToken)).toBe('ok')

    expect(readCredentialRevokeAudits(sqlite)).toHaveLength(1)
  })

  test('a stale revoked token cannot delete newer unlinked CLI sessions', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const [familyId] = readRefreshFamilies(sqlite)
    await revokeCliRefreshCredentialFamily(db, 'u1', familyId!)
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
         ) VALUES ('newer-unlinked', 'u1', 'ass_newer', '2099-01-01T00:00:00.000Z',
           NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()

    await revokeCliRefreshCredential(db, issued.refreshToken)

    expect(
      sqlite
        .prepare("SELECT token FROM sessions WHERE id = 'newer-unlinked'")
        .get(),
    ).toEqual({
      token: 'ass_newer',
    })
  })

  test('revoke all deletes an unlinked device-login session with a random token', async () => {
    await issueCliRefreshCredential(db, 'u1')
    sqlite
      .prepare(
        `INSERT INTO sessions (
           id, user_id, token, expires_at, ip_address, user_agent, created_at, updated_at
         ) VALUES ('unlinked-device', 'u1', 'random-better-auth-token',
           '2099-01-01T00:00:00.000Z', NULL, 'artifactshare-cli-device',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()

    await revokeAllCliRefreshCredentialFamilies(db, 'u1')

    expect(
      sqlite
        .prepare("SELECT id FROM sessions WHERE id = 'unlinked-device'")
        .get(),
    ).toBeUndefined()
  })

  test('revoke all includes a family issued immediately before its batch', async () => {
    await issueCliRefreshCredential(db, 'u1')
    sqliteRef.beforeNextBatch = () => {
      sqlite
        .prepare(
          `INSERT INTO cli_refresh_credentials (
             id, user_id, token_hash, expires_at, created_at, family_id
           ) VALUES (?, 'u1', ?, '2099-01-01T00:00:00.000Z', ?, ?)`,
        )
        .run(
          'racing-credential',
          'racing-token-hash',
          '2026-01-01T00:00:00.000Z',
          'racing-family',
        )
    }

    await revokeAllCliRefreshCredentialFamilies(db, 'u1')

    expect(readActiveRefreshFamilies(sqlite)).toHaveLength(0)
    expect(readCredentialRevokeAudits(sqlite)).toHaveLength(2)
  })

  test('revoke all audits a rotated family once', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    expect(
      await refreshCliSession(db, issued.refreshToken, 'rotate-once', secret),
    ).toMatchObject({ kind: 'ok' })

    await revokeAllCliRefreshCredentialFamilies(db, 'u1')

    expect(readCredentialRevokeAudits(sqlite)).toHaveLength(1)
  })

  test('revoke all remains idempotent for requests in the same millisecond', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-11T00:00:00.000Z'))
    try {
      await issueCliRefreshCredential(db, 'u1')

      await revokeAllCliRefreshCredentialFamilies(db, 'u1')
      await revokeAllCliRefreshCredentialFamilies(db, 'u1')

      expect(readCredentialRevokeAudits(sqlite)).toHaveLength(1)
    } finally {
      vi.useRealTimers()
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
    ).toBe('forbidden')
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
