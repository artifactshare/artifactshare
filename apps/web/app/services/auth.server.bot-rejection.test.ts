import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import type { DB } from '~/types/db'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1MockFromSqliteRef(sqliteRef),
    BETTER_AUTH_SECRET: 'test-secret-with-enough-entropy-for-bot-tests',
    BETTER_AUTH_URL: 'https://example.com',
  },
}))

const {
  assertBotSignInAllowedForEmail,
  assertBotSignInAllowedForUserId,
  getSessionUserFromBearer,
} = await import('./auth.server')

describe('bot sign-in rejection', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    sqliteRef.current = sqlite
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
    sqlite
      .prepare(
        `INSERT INTO users (
          id, email, email_verified, name, created_at, updated_at,
          workspace_id, kind
        ) VALUES ('bot1', 'bot-abc@bots.artifactshare.invalid', 1, 'Bot',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'ws1', 'bot')`,
      )
      .run()
  })

  afterEach(async () => {
    await db.destroy()
    sqliteRef.current = null
  })

  test('reserved-domain addresses are rejected even without a user row', async () => {
    await expect(
      assertBotSignInAllowedForEmail(db, 'anything@bots.artifactshare.invalid'),
    ).rejects.toMatchObject({ body: { code: 'bot-sign-in-rejected' } })
    await expect(
      assertBotSignInAllowedForEmail(db, 'other@sub.invalid'),
    ).rejects.toMatchObject({ body: { code: 'bot-sign-in-rejected' } })
  })

  test('bot user emails and ids are rejected; humans pass', async () => {
    await expect(
      assertBotSignInAllowedForEmail(db, 'BOT-ABC@bots.artifactshare.invalid'),
    ).rejects.toMatchObject({ body: { code: 'bot-sign-in-rejected' } })
    await expect(
      assertBotSignInAllowedForUserId(db, 'bot1'),
    ).rejects.toMatchObject({ body: { code: 'bot-sign-in-rejected' } })
    await expect(
      assertBotSignInAllowedForEmail(db, 'u1@example.com'),
    ).resolves.toBeUndefined()
    await expect(assertBotSignInAllowedForUserId(db, 'u1')).resolves.toBeUndefined()
  })

  test('a bearer session for a bot still resolves (CLI path stays open)', async () => {
    // The bearer path returns the bot user; the authority resolver (not this
    // lookup) decides whether the request is allowed.
    sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, token, expires_at, created_at, updated_at)
         VALUES ('bs1', 'bot1', 'ass_bot', '2099-01-01T00:00:00.000Z',
           '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      )
      .run()
    const request = new Request('https://example.com/api/cli/whoami', {
      headers: { authorization: 'Bearer ass_bot' },
    })
    const user = await getSessionUserFromBearer(request)
    expect(user?.kind).toBe('bot')
  })
})
