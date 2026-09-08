import { DatabaseSync } from 'node:sqlite'
import { describe, expect, test } from 'vitest'
import { createD1BatchDbMock, type D1BatchSqliteRef } from './d1-batch-mock'

function createFixture() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('CREATE TABLE entries (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const sqliteRef: D1BatchSqliteRef = { current: sqlite }
  return {
    database: createD1BatchDbMock({ sqlite: sqliteRef }),
    sqlite,
    sqliteRef,
  }
}

describe('D1 batch mock', () => {
  test('preserves a post-commit hook error after committing the SQL batch', async () => {
    const { database, sqlite, sqliteRef } = createFixture()
    const hookError = new Error('post-commit response lost')
    sqliteRef.afterNextBatch = () => {
      throw hookError
    }

    await expect(
      database.batch([
        database
          .prepare('INSERT INTO entries (id, value) VALUES (?, ?)')
          .bind('committed', 'value'),
      ]),
    ).rejects.toBe(hookError)

    expect(
      sqlite.prepare("SELECT value FROM entries WHERE id = 'committed'").get(),
    ).toEqual({ value: 'value' })
    expect(sqliteRef.afterNextBatch).toBeNull()
  })

  test('rolls back preceding statements when a SQL statement fails', async () => {
    const { database, sqlite } = createFixture()

    await expect(
      database.batch([
        database
          .prepare('INSERT INTO entries (id, value) VALUES (?, ?)')
          .bind('rolled-back', 'first'),
        database
          .prepare('INSERT INTO entries (id, value) VALUES (?, ?)')
          .bind('rolled-back', 'duplicate'),
      ]),
    ).rejects.toThrow('UNIQUE constraint failed: entries.id')

    expect(
      sqlite.prepare('SELECT COUNT(*) AS count FROM entries').get(),
    ).toEqual({ count: 0 })
  })
})
