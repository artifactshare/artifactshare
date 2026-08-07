import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { seedSession, seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { createApiToken, revokeApiToken } from './api-tokens.server'

const d1TestRef = vi.hoisted(() => ({
  sqliteRef: { current: null as DatabaseSync | null },
}))

vi.mock('cloudflare:workers', () => ({
  env: { DB: createD1MockFromSqliteRef(d1TestRef.sqliteRef) },
}))

import { getSessionUserFromBearer } from './auth.server'

describe('getSessionUserFromBearer', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    d1TestRef.sqliteRef.current = sqlite
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
  })

  afterEach(async () => {
    d1TestRef.sqliteRef.current = null
    await db.destroy()
  })

  test('authenticates with a valid ast_ API token', async () => {
    const created = await createApiToken(db, 'u1', 'CI deploy')
    const request = bearerRequest(created.token)

    await expect(getSessionUserFromBearer(request)).resolves.toEqual({
      id: 'u1',
      email: 'u1@example.com',
      emailVerified: true,
      name: 'User u1',
      image: null,
      locale: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      msTenantId: null,
      selfUploadEnabled: true,
    })
  })

  test('returns null for a revoked ast_ API token', async () => {
    const created = await createApiToken(db, 'u1', 'CI deploy')
    await revokeApiToken(db, 'u1', created.id)

    await expect(
      getSessionUserFromBearer(bearerRequest(created.token)),
    ).resolves.toBeNull()
  })

  test('authenticates with a traditional session token', async () => {
    const sessionToken = 'sess_plain_token'
    seedSession(sqlite, 'u1', sessionToken)

    await expect(
      getSessionUserFromBearer(bearerRequest(sessionToken)),
    ).resolves.toEqual({
      id: 'u1',
      email: 'u1@example.com',
      emailVerified: true,
      name: 'User u1',
      image: null,
      locale: null,
      workspaceId: 'ws1',
      hd: 'example.com',
      msTenantId: null,
      selfUploadEnabled: true,
    })
  })

  test('updates last_used_at after successful ast_ authentication', async () => {
    const created = await createApiToken(db, 'u1', 'CI deploy')
    expect(readTokenRow(sqlite, created.id).last_used_at).toBeNull()

    await getSessionUserFromBearer(bearerRequest(created.token))

    expect(readTokenRow(sqlite, created.id).last_used_at).not.toBeNull()
  })

  test('ast_ authentication queries api_tokens twice (join lookup + last_used touch)', async () => {
    let apiTokenQueryCount = 0
    const countingSqlite = new Proxy(sqlite, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/\bapi_tokens\b/i.test(sql)) {
              apiTokenQueryCount++
            }
            return target.prepare(sql)
          }
        }
        return Reflect.get(target, prop, receiver)
      },
    })
    d1TestRef.sqliteRef.current = countingSqlite

    const created = await createApiToken(db, 'u1', 'CI deploy')
    await getSessionUserFromBearer(bearerRequest(created.token))

    expect(apiTokenQueryCount).toBe(2)
  })

  test('session bearer authentication fails after member removal deletes sessions', async () => {
    const sessionToken = 'sess_removed_user'
    seedSession(sqlite, 'u1', sessionToken)

    sqlite.exec(`DELETE FROM sessions WHERE user_id = 'u1';`)

    await expect(
      getSessionUserFromBearer(bearerRequest(sessionToken)),
    ).resolves.toBeNull()
  })

  test('API token bearer resolves the personal workspace after member removal', async () => {
    const created = await createApiToken(db, 'u1', 'CI deploy')
    sqlite.exec(`
      INSERT INTO workspaces (
        id, hd, name, created_at, plan, storage_quota_bytes, storage_used_bytes,
        storage_updated_at
      ) VALUES (
        'ws-personal', NULL, 'Personal', '2026-05-26T00:00:00.000Z', 'free',
        104857600, 0, '2026-05-26T00:00:00.000Z'
      );
      UPDATE users SET workspace_id = 'ws-personal' WHERE id = 'u1';
    `)

    await expect(
      getSessionUserFromBearer(bearerRequest(created.token)),
    ).resolves.toMatchObject({
      id: 'u1',
      workspaceId: 'ws-personal',
    })
  })
})

function bearerRequest(token: string): Request {
  return new Request('https://example.com/api/cli/whoami', {
    headers: { authorization: `Bearer ${token}` },
  })
}

function readTokenRow(db: DatabaseSync, id: string) {
  return db
    .prepare(
      `SELECT last_used_at, revoked_at
       FROM api_tokens
       WHERE id = ?`,
    )
    .get(id) as {
    last_used_at: string | null
    revoked_at: string | null
  }
}
