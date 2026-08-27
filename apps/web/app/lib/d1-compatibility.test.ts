import { type Kysely, sql } from 'kysely'
import { afterEach, describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'

describe('d1CompatibilityPlugin', () => {
  let db: Kysely<DB> | undefined

  function createTestDb(): Kysely<DB> {
    return createMigratedInMemoryDb().db
  }

  afterEach(async () => {
    await db?.destroy()
  })

  test('allows an ordinary query and a two-term compound SELECT', () => {
    db = createTestDb()
    expect(() => db!.selectFrom('users').select('id').compile()).not.toThrow()
    expect(() =>
      db!
        .selectFrom('users')
        .select('id')
        .unionAll(db!.selectFrom('users').select('id'))
        .compile(),
    ).not.toThrow()
  })

  test('rejects a compound SELECT assembled through reassignment', () => {
    db = createTestDb()
    let query = db.selectFrom('users').select('id')
    query = query.unionAll(db.selectFrom('users').select('id'))
    query = query.unionAll(db.selectFrom('users').select('id'))

    expect(() => query.compile()).toThrow(
      'compound SELECTs may contain at most two terms',
    )
  })

  test('rejects a nested compound SELECT that compiles to three terms', () => {
    db = createTestDb()
    const right = db
      .selectFrom('users')
      .select('id')
      .unionAll(db.selectFrom('users').select('id'))
    const query = db.selectFrom('users').select('id').unionAll(right)

    expect(() => query.compile()).toThrow(
      'compound SELECTs may contain at most two terms',
    )
  })

  test('rejects a compound SELECT inside EXISTS', () => {
    db = createTestDb()
    const compound = db
      .selectFrom('users')
      .select('id')
      .unionAll(db.selectFrom('users').select('id'))
    const query = db
      .selectFrom('users')
      .select(({ exists }) => exists(compound).as('found'))

    expect(() => query.compile()).toThrow(
      'compound SELECTs are not allowed inside EXISTS',
    )
  })

  test('rejects a compound builder interpolated into raw EXISTS SQL', () => {
    db = createTestDb()
    const compound = db
      .selectFrom('users')
      .select('id')
      .unionAll(db.selectFrom('users').select('id'))
    const query = sql<boolean>`SELECT EXISTS ${compound}`

    expect(() => query.compile(db!)).toThrow(
      'compound SELECTs are not allowed inside EXISTS',
    )
  })

  test('rejects a compound builder hidden inside nested raw SQL', () => {
    db = createTestDb()
    const compound = db
      .selectFrom('users')
      .select('id')
      .unionAll(db.selectFrom('users').select('id'))
    const fragment = sql`${compound}`
    const query = sql<boolean>`SELECT EXISTS ${fragment}`

    expect(() => query.compile(db!)).toThrow(
      'compound SELECTs must not be embedded in raw SQL',
    )
  })
})
