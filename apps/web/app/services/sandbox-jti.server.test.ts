import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { consumeJti } from './sandbox-jti.server'

describe('consumeJti', () => {
  let db: Kysely<DB>

  beforeEach(() => {
    db = createMigratedInMemoryDb().db
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('rejects sequential replay', async () => {
    const expiresAt = '2026-01-01T00:01:00Z'

    await expect(consumeJti(db, 'j1', expiresAt)).resolves.toBe(true)
    await expect(consumeJti(db, 'j1', expiresAt)).resolves.toBe(false)
  })

  // node:sqlite serializes writes within one connection, so Promise.all here
  // doesn't reproduce a true edge-level race — it asserts the contract
  // (exactly one inserter wins) that the D1 PK constraint enforces in prod.
  test('allows exactly one concurrent consume', async () => {
    const results = await Promise.all([
      consumeJti(db, 'j2', '2026-01-01T00:01:00Z'),
      consumeJti(db, 'j2', '2026-01-01T00:01:00Z'),
    ])

    expect(results.filter(Boolean)).toHaveLength(1)
  })
})
