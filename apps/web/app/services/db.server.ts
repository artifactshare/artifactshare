import { env } from 'cloudflare:workers'
import { Kysely } from 'kysely'
import {
  ConcurrentD1Dialect,
  d1CompatibilityPlugin,
} from '~/lib/d1-compatibility.server'
import { associateD1Database } from '~/lib/d1-database-registry.server'
import type { DB } from '~/types/db'

export { d1DatabaseFor } from '~/lib/d1-database-registry.server'

export function createDb(database: D1Database = env.DB): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: new ConcurrentD1Dialect({ database }),
    plugins: [d1CompatibilityPlugin],
  })
  associateD1Database(db, database)
  return db
}

export type Db = ReturnType<typeof createDb>

export async function withDb<T>(
  fn: (db: Db) => Promise<T>,
  database?: D1Database,
): Promise<T> {
  const db = createDb(database)
  try {
    return await fn(db)
  } finally {
    await db.destroy()
  }
}
