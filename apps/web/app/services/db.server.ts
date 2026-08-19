import { env } from 'cloudflare:workers'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import type { DB } from '~/types/db'

const d1Databases = new WeakMap<Kysely<DB>, D1Database>()

export function createDb(database: D1Database = env.DB): Kysely<DB> {
  const db = new Kysely<DB>({
    dialect: new D1Dialect({ database }),
  })
  d1Databases.set(db, database)
  return db
}

export function d1DatabaseFor(db: Kysely<DB>): D1Database | undefined {
  return d1Databases.get(db)
}

export type Db = ReturnType<typeof createDb>

/**
 * Open a Kysely connection, run `fn`, and always destroy it. Keeps route
 * loaders from repeating the create / try / finally / destroy boilerplate.
 */
export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const db = createDb()
  try {
    return await fn(db)
  } finally {
    await db.destroy()
  }
}
