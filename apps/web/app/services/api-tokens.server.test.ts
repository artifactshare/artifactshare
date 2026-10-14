import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'
import {
  createApiToken,
  findUserByApiToken,
  isApiToken,
  listApiTokens,
  revokeApiToken,
  touchApiTokenLastUsedByHash,
} from './api-tokens.server'

const sqliteRef = vi.hoisted(() => ({ current: null as DatabaseSync | null }))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1BatchDbMock({ sqlite: sqliteRef }) },
}))

import { removeWorkspaceMember } from './team-management.server'

describe('api-tokens service', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqlite = fixture.sqlite
    sqliteRef.current = sqlite
    db = fixture.db
  })

  afterEach(async () => {
    sqliteRef.current = null
    await db.destroy()
  })

  test('create lists token metadata and stores only a hash', async () => {
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')

    const created = await createApiToken(db, 'u1', 'CI deploy')
    const listed = await listApiTokens(db, 'u1')
    const stored = readTokenRow(sqlite, created.id)

    expect(created.token).toMatch(/^ast_/)
    expect(created.token).toHaveLength(47)
    expect(created.token.includes('.')).toBe(false)
    expect(listed).toEqual([
      {
        id: created.id,
        name: 'CI deploy',
        createdAt: created.createdAt,
        lastUsedAt: null,
      },
    ])
    expect(stored.token_hash).not.toBe(created.token)
    expect(stored.token_hash).toHaveLength(64)
  })

  test('isApiToken detects ast_ prefix', () => {
    expect(isApiToken('ast_abc')).toBe(true)
    expect(isApiToken('sess_token')).toBe(false)
  })

  test('findUserByApiToken resolves active tokens only', async () => {
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')

    const created = await createApiToken(db, 'u1', 'CI deploy')

    expect(await findUserByApiToken(db, created.token)).toEqual({
      id: 'u1',
      email: 'u1@example.com',
      email_verified: 1,
      name: 'User u1',
      image: null,
      workspace_id: 'ws1',
      locale: null,
      tokenHash: readTokenRow(sqlite, created.id).token_hash,
    })
    expect(await findUserByApiToken(db, 'ast_unknown')).toBeNull()

    await revokeApiToken(db, 'u1', created.id)

    expect(await findUserByApiToken(db, created.token)).toBeNull()
  })

  test('revokeApiToken is owner-only and hides revoked tokens from the list', async () => {
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')

    const created = await createApiToken(db, 'u1', 'CI deploy')

    expect(await revokeApiToken(db, 'u2', created.id)).toBe(false)
    expect(await listApiTokens(db, 'u1')).toHaveLength(1)

    expect(await revokeApiToken(db, 'u1', created.id)).toBe(true)
    expect(await listApiTokens(db, 'u1')).toEqual([])
    expect(readTokenRow(sqlite, created.id).revoked_at).not.toBeNull()
  })

  test('touchApiTokenLastUsedByHash writes once per hour slot', async () => {
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')

    const created = await createApiToken(db, 'u1', 'CI deploy')
    const tokenHash = readTokenRow(sqlite, created.id).token_hash

    expect(readTokenRow(sqlite, created.id).last_used_at).toBeNull()

    await touchApiTokenLastUsedByHash(db, tokenHash)
    const firstTouch = readTokenRow(sqlite, created.id).last_used_at
    expect(firstTouch).not.toBeNull()

    await touchApiTokenLastUsedByHash(db, tokenHash)
    expect(readTokenRow(sqlite, created.id).last_used_at).toBe(firstTouch)
  })

  test('findUserByApiToken rejects a token issued before member removal', async () => {
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
    seedUser(sqlite, 'u2')
    sqlite.exec(`
      INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
      VALUES ('ws1', 'u1', 'member', 'active', '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z'),
             ('ws1', 'u2', 'admin', 'active', '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z');
    `)

    const created = await createApiToken(db, 'u1', 'CI deploy')
    expect(await findUserByApiToken(db, created.token)).toMatchObject({
      id: 'u1',
      workspace_id: 'ws1',
    })

    expect(
      await removeWorkspaceMember(db, { id: 'u2', workspaceId: 'ws1' }, 'u1'),
    ).toEqual({ kind: 'ok' })

    expect(await findUserByApiToken(db, created.token)).toBeNull()
  })
})

function readTokenRow(db: DatabaseSync, id: string) {
  return db
    .prepare(
      `SELECT token_hash, last_used_at, revoked_at
       FROM api_tokens
       WHERE id = ?`,
    )
    .get(id) as {
    token_hash: string
    last_used_at: string | null
    revoked_at: string | null
  }
}
