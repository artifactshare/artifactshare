import { env } from 'cloudflare:workers'
import type { Compilable } from 'kysely'

export async function runD1Batch(
  ...queries: Compilable<unknown>[]
): Promise<void> {
  // Service tests use an in-process Kysely database without a Workers binding.
  // Production always takes the D1 batch path below.
  if (!env.DB) {
    for (const query of queries)
      await (query as unknown as { execute: () => Promise<unknown> }).execute()
    return
  }
  const stmts = queries.map((query) => {
    const compiled = query.compile()
    return env.DB.prepare(compiled.sql).bind(...compiled.parameters)
  })
  await env.DB.batch(stmts)
}
