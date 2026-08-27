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

  test('allows an ordinary query and a five-term compound SELECT', () => {
    db = createTestDb()
    expect(() => db!.selectFrom('users').select('id').compile()).not.toThrow()
    let query = db!.selectFrom('users').select('id')
    for (let index = 0; index < 4; index += 1) {
      query = query.unionAll(db!.selectFrom('users').select('id'))
    }
    expect(() => query.compile()).not.toThrow()
  })

  test('rejects a six-term compound SELECT assembled through reassignment', () => {
    db = createTestDb()
    let query = db.selectFrom('users').select('id')
    for (let index = 0; index < 5; index += 1) {
      query = query.unionAll(db.selectFrom('users').select('id'))
    }

    expect(() => query.compile()).toThrow(
      'compound SELECTs may contain at most five terms',
    )
  })

  test('rejects a nested compound SELECT that compiles to six terms', () => {
    db = createTestDb()
    let right = db.selectFrom('users').select('id')
    for (let index = 0; index < 4; index += 1) {
      right = right.unionAll(db.selectFrom('users').select('id'))
    }
    const query = db.selectFrom('users').select('id').unionAll(right)

    expect(() => query.compile()).toThrow(
      'compound SELECTs may contain at most five terms',
    )
  })

  test('allows a five-term compound SELECT inside EXISTS', () => {
    db = createTestDb()
    let compound = db.selectFrom('users').select('id')
    for (let index = 0; index < 4; index += 1) {
      compound = compound.unionAll(db.selectFrom('users').select('id'))
    }
    const query = db
      .selectFrom('users')
      .select(({ exists }) => exists(compound).as('found'))

    expect(() => query.compile()).not.toThrow()
  })

  test('allows a compound builder interpolated into raw EXISTS SQL', () => {
    db = createTestDb()
    const compound = db
      .selectFrom('users')
      .select('id')
      .unionAll(db.selectFrom('users').select('id'))
    const query = sql<boolean>`SELECT EXISTS ${compound}`

    expect(() => query.compile(db!)).not.toThrow()
  })

  test('allows a bounded compound builder inside nested raw SQL', () => {
    db = createTestDb()
    const compound = db
      .selectFrom('users')
      .select('id')
      .unionAll(db.selectFrom('users').select('id'))
    const fragment = sql`${compound}`
    const query = sql<boolean>`SELECT EXISTS ${fragment}`

    expect(() => query.compile(db!)).not.toThrow()
  })

  test('allows 100 bound parameters', () => {
    db = createTestDb()
    const values = Array.from({ length: 100 }, (_, index) => `user-${index}`)

    expect(() =>
      db!.selectFrom('users').select('id').where('id', 'in', values).compile(),
    ).not.toThrow()
  })

  test('rejects 101 bound parameters', () => {
    db = createTestDb()
    const values = Array.from({ length: 101 }, (_, index) => `user-${index}`)

    expect(() =>
      db!.selectFrom('users').select('id').where('id', 'in', values).compile(),
    ).toThrow('queries may bind at most 100 parameters')
  })
})
