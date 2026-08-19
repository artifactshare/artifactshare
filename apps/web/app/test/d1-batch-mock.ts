import type { DatabaseSync } from 'node:sqlite'
import { associateD1Database } from '~/lib/d1-database-registry.server'
import { createMigratedInMemoryDb } from './sqlite-fixture'

export type D1BatchStmt = { sql: string; params: unknown[] }

export type D1BatchSqliteRef = {
  current: DatabaseSync | null
  failNextBatch?: boolean
  beforeNextBatch?: ((stmts: D1BatchStmt[]) => void | Promise<void>) | null
}

export type D1BatchMockOptions = {
  sqlite: D1BatchSqliteRef
  beforeBatch?: {
    current: ((batchIndex: number) => void) | null
  }
  batchCount?: { current: number }
}

export function createD1BatchDbMock(options: D1BatchMockOptions) {
  return {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => ({ sql, params }),
    }),
    batch: async (stmts: D1BatchStmt[]) => {
      const sqlite = options.sqlite.current
      if (!sqlite) throw new Error('sqlite not bound in test')

      options.beforeBatch?.current?.(options.batchCount?.current ?? 0)
      if (options.batchCount) {
        options.batchCount.current += 1
      }

      if (options.sqlite.beforeNextBatch) {
        const hook = options.sqlite.beforeNextBatch
        options.sqlite.beforeNextBatch = null
        await hook(stmts)
      }

      if (options.sqlite.failNextBatch) {
        options.sqlite.failNextBatch = false
        throw new Error('induced batch failure')
      }

      sqlite.exec('BEGIN')
      try {
        for (const stmt of stmts) {
          sqlite.prepare(stmt.sql).run(...(stmt.params as never[]))
        }
        sqlite.exec('COMMIT')
      } catch (err) {
        sqlite.exec('ROLLBACK')
        throw err
      }
    },
  }
}

export function createD1BatchFixture(options: D1BatchMockOptions) {
  const fixture = createMigratedInMemoryDb()
  associateD1Database(
    fixture.db,
    createD1BatchDbMock(options) as unknown as D1Database,
  )
  return fixture
}
