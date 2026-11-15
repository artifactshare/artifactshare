import { afterEach, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
vi.mock('cloudflare:workers', () => ({ env: {} }))
import {
  readOnlyOAuthKeys,
  verifyOAuthJwt,
  verifyOAuthBinding,
} from './oauth-verification.server'

afterEach(() => vi.restoreAllMocks())
test('missing stored keys fail unavailable without key generation, even with a JWT-shaped token', async () => {
  const { db, sqlite } = createMigratedInMemoryDb()
  try {
    await expect(readOnlyOAuthKeys(db)).rejects.toThrow('keys unavailable')
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM jwks').get(),
    ).toMatchObject({ n: 0 })
  } finally {
    await db.destroy()
  }
})
test('public-key projection matches pinned algorithm/grace and never reads private material', async () => {
  const { db, sqlite } = createMigratedInMemoryDb()
  try {
    sqlite
      .prepare(
        'INSERT INTO jwks(id,publicKey,privateKey,createdAt,expiresAt) VALUES (?,?,?,?,?)',
      )
      .run(
        'synthetic-key',
        '{"kty":"OKP","crv":"Ed25519","x":"synthetic"}',
        'CANARY_PRIVATE',
        '2026-01-01',
        new Date(Date.now() - 86400000).toISOString(),
      )
    const prepare = vi.spyOn(sqlite, 'prepare')
    const keys = await readOnlyOAuthKeys(db)
    expect(keys).toEqual({
      keys: [
        {
          kid: 'synthetic-key',
          kty: 'OKP',
          alg: 'EdDSA',
          crv: 'Ed25519',
          x: 'synthetic',
        },
      ],
    })
    expect(prepare.mock.calls.flat().join(' ')).not.toContain('privateKey')
    expect(JSON.stringify(keys)).not.toContain('CANARY')
    sqlite.exec("UPDATE jwks SET expiresAt='2000-01-01'")
    await expect(readOnlyOAuthKeys(db)).rejects.toThrow('keys unavailable')
  } finally {
    await db.destroy()
  }
})
test('binding checks version and sid owner without session expiry deletion', async () => {
  const { db, sqlite } = createMigratedInMemoryDb()
  try {
    seedWorkspace(sqlite)
    seedUser(sqlite, 'u1')
    sqlite.exec(
      "INSERT INTO sessions(id,user_id,token,expires_at,created_at,updated_at) VALUES ('s','u1','synthetic','2000-01-01','2000-01-01','2000-01-01')",
    )
    expect(await verifyOAuthBinding(db, 'u1', undefined, 's')).toBe(true)
    expect(await verifyOAuthBinding(db, 'u1', 1, 's')).toBe(false)
    expect(await verifyOAuthBinding(db, 'u1', '0', 's')).toBe(false)
    expect(await verifyOAuthBinding(db, 'u1', 0, 'missing')).toBe(false)
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM sessions').get(),
    ).toMatchObject({ n: 1 })
  } finally {
    await db.destroy()
  }
})
test('malformed JWT does not authenticate decoded claims', async () => {
  const result = await verifyOAuthJwt(
    'bad.bad.bad',
    'https://app.example.test',
    async () => {
      throw new Error('CANARY_KEYS')
    },
  )
  expect(result.kind).not.toBe('verified')
  expect(JSON.stringify(result)).not.toContain('CANARY')
})
