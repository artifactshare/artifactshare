import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  issueCliRefreshCredential,
  refreshCliSession,
} from './cli-refresh-credentials.server'

describe('cli-refresh-credentials service', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
  })

  afterEach(async () => {
    await db.destroy()
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

  test('refreshes a session and records last use', async () => {
    const issued = await issueCliRefreshCredential(db, 'u1')
    const result = await refreshCliSession(db, issued.refreshToken)

    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.sessionToken).toMatch(/^ass_/)

    const session = sqlite
      .prepare(`SELECT user_id, token, expires_at FROM sessions`)
      .get() as { user_id: string; token: string; expires_at: string }
    expect(session).toEqual({
      user_id: 'u1',
      token: result.sessionToken,
      expires_at: result.expiresAt,
    })
    expect(readRefreshRow(sqlite).last_used_at).not.toBeNull()
  })

  test('rejects unknown expired and revoked refresh credentials', async () => {
    expect(await refreshCliSession(db, 'asr_unknown')).toEqual({
      kind: 'invalid',
    })

    const expired = await issueCliRefreshCredential(db, 'u1')
    sqlite
      .prepare(
        `UPDATE cli_refresh_credentials
         SET expires_at = '2000-01-01T00:00:00.000Z'`,
      )
      .run()
    expect(await refreshCliSession(db, expired.refreshToken)).toEqual({
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
    expect(await refreshCliSession(db, revoked.refreshToken)).toEqual({
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

    const result = await refreshCliSession(db, issued.refreshToken)

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
})

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
