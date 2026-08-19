import type { Compilable, Kysely } from 'kysely'
import { d1DatabaseFor } from '~/lib/d1-database-registry.server'
import type { DB } from '~/types/db'

export async function runD1Batch(
  db: Kysely<DB>,
  ...queries: Compilable<unknown>[]
): Promise<void> {
  // Service tests use an in-process Kysely database without a Workers binding.
  // Production always takes the D1 batch path below.
  const database = d1DatabaseFor(db)
  if (!database) {
    for (const query of queries)
      await (query as unknown as { execute: () => Promise<unknown> }).execute()
    return
  }
  const stmts = queries.map((query) => {
    const compiled = query.compile()
    return database.prepare(compiled.sql).bind(...compiled.parameters)
  })
  await database.batch(stmts)
}
