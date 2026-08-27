import type { Compilable, Kysely } from 'kysely'
import { d1DatabaseFor } from '~/lib/d1-database-registry.server'
import type { DB } from '~/types/db'

export async function runD1Batch(
  db: Kysely<DB>,
  ...queries: Compilable<unknown>[]
): Promise<void> {
  await runD1BatchWithResults(db, ...queries)
}

export async function runD1BatchWithResults(
  db: Kysely<DB>,
  ...queries: Compilable<unknown>[]
): Promise<unknown[]> {
  // Service tests use an in-process Kysely database without a Workers binding.
  // Production always takes the D1 batch path below.
  const database = d1DatabaseFor(db)
  if (!database) {
    const results: unknown[] = []
    for (const query of queries) {
      results.push(
        await (
          query as unknown as { execute: () => Promise<unknown> }
        ).execute(),
      )
    }
    return results
  }
  const stmts = queries.map((query) => {
    const compiled = query.compile()
    return database.prepare(compiled.sql).bind(...compiled.parameters)
  })
  return await database.batch(stmts)
}
