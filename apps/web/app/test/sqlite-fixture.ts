import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DatabaseSync as DatabaseSyncCtor } from 'node:sqlite'
import { Kysely, SqliteDialect } from 'kysely'
import { d1CompatibilityPlugin } from '~/lib/d1-compatibility.server'
import type { DB } from '~/types/db'

const MIGRATIONS_DIR = new URL('../../db/migrations', import.meta.url).pathname
const SCHEMA_PATH = new URL('../../db/schema.sql', import.meta.url).pathname

export function loadMigrations(): Array<{ name: string; sql: string }> {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => ({
      name,
      sql: readFileSync(join(MIGRATIONS_DIR, name), 'utf8'),
    }))
}

export function applyMigrations(
  sqlite: DatabaseSync,
  migrations?: Array<{ sql: string }>,
) {
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const m of migrations ?? loadMigrations()) sqlite.exec(m.sql)
}

function createSqliteKysely(sqlite: DatabaseSync): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new SqliteDialect({ database: sqliteDatabaseBridge(sqlite) }),
    plugins: [d1CompatibilityPlugin],
  })
}

export function createMigratedInMemoryDb(): {
  sqlite: DatabaseSync
  db: Kysely<DB>
} {
  const sqlite = new DatabaseSyncCtor(':memory:')
  sqlite.exec(readFileSync(SCHEMA_PATH, 'utf8'))
  return { sqlite, db: createSqliteKysely(sqlite) }
}

function isSqliteReaderStatement(sql: string): boolean {
  return /^\s*(select|with|pragma)\b/i.test(sql) || /\breturning\b/i.test(sql)
}

export function createD1MockFromSqliteRef(sqliteRef: {
  current: DatabaseSync | null
}) {
  const database = {
    prepare: (sql: string) => ({
      bind: (...params: unknown[]) => {
        const all = () => {
          const sqlite = sqliteRef.current
          if (!sqlite) throw new Error('sqlite not bound in test')
          const stmt = sqlite.prepare(sql)
          if (isSqliteReaderStatement(sql)) {
            const results = stmt.all(...(params as never[]))
            return Promise.resolve({
              success: true,
              results,
              meta: { changes: 0, last_row_id: null },
            })
          }
          const result = stmt.run(...(params as never[]))
          return Promise.resolve({
            success: true,
            results: [],
            meta: {
              changes: result.changes,
              last_row_id: Number(result.lastInsertRowid),
            },
          })
        }
        return {
          all,
          run: all,
          first: async () => {
            const result = await all()
            return result.results[0] ?? null
          },
        }
      },
    }),
    batch: (statements: Array<{ all: () => Promise<unknown> }>) =>
      Promise.all(statements.map((statement) => statement.all())),
  }
  return database
}

// Bridge node:sqlite DatabaseSync into kysely SqliteDialect's expected shape.
// The reader flag must be true for any statement whose result rows the dialect
// will consume — SELECT / WITH / PRAGMA, plus INSERT/UPDATE/DELETE … RETURNING.
function sqliteDatabaseBridge(db: DatabaseSync) {
  return {
    close: () => db.close(),
    prepare: (sql: string) => {
      const stmt = db.prepare(sql)
      return {
        reader: isSqliteReaderStatement(sql),
        all: (parameters: ReadonlyArray<unknown>) =>
          stmt.all(...(parameters as never[])),
        run: (parameters: ReadonlyArray<unknown>) =>
          stmt.run(...(parameters as never[])),
        iterate: (parameters: ReadonlyArray<unknown>) =>
          stmt.iterate(...(parameters as never[])),
      }
    },
  }
}
