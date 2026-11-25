import type { DatabaseSync } from 'node:sqlite'

// A D1Database-shaped binding over node:sqlite, for service tests that need
// real SQL and D1's batch and change-metadata semantics without starting
// Miniflare. It covers what the product calls: prepare().bind().all()/.run()
// and batch(). batch() runs its statements in one transaction, as D1 does, and
// meta.changes counts the work SQLite triggers record, as D1's metadata does.
type Bound = { sql: string; params: unknown[] }

type Result = {
  success: true
  results: unknown[]
  meta: { changes: number; last_row_id: number }
}

type Statement = {
  bound: Bound
  bind: (...params: unknown[]) => Statement
  all: () => Promise<Result>
  run: () => Promise<Result>
}

function scalar(sqlite: DatabaseSync, sql: string): number {
  return (sqlite.prepare(sql).get() as { value: number }).value
}

function execute(sqlite: DatabaseSync, { sql, params }: Bound): Result {
  const statement = sqlite.prepare(sql)
  // node:sqlite binds numbers, not booleans.
  const values = params.map((param) =>
    typeof param === 'boolean' ? Number(param) : param,
  ) as never[]
  const before = scalar(sqlite, 'SELECT total_changes() AS value')
  const reader = statement.columns().length > 0
  const results = reader ? statement.all(...values) : []
  if (!reader) statement.run(...values)
  return {
    success: true,
    results,
    meta: {
      changes: scalar(sqlite, 'SELECT total_changes() AS value') - before,
      last_row_id: scalar(sqlite, 'SELECT last_insert_rowid() AS value'),
    },
  }
}

function prepare(
  sqlite: DatabaseSync,
  sql: string,
  params: unknown[] = [],
): Statement {
  const bound: Bound = { sql, params }
  return {
    bound,
    bind: (...next: unknown[]) => prepare(sqlite, sql, next),
    all: () => Promise.resolve(execute(sqlite, bound)),
    run: () => Promise.resolve(execute(sqlite, bound)),
  }
}

function batch(
  sqlite: DatabaseSync,
  statements: Statement[],
): Promise<Result[]> {
  sqlite.exec('BEGIN')
  try {
    const results = statements.map((statement) =>
      execute(sqlite, statement.bound),
    )
    sqlite.exec('COMMIT')
    return Promise.resolve(results)
  } catch (error) {
    sqlite.exec('ROLLBACK')
    throw error
  }
}

export function d1OnSqlite(sqlite: DatabaseSync): D1Database {
  return {
    prepare: (sql: string) => prepare(sqlite, sql),
    batch: (statements: Statement[]) => batch(sqlite, statements),
  } as unknown as D1Database
}
