import { env } from 'cloudflare:workers'
import { Kysely } from 'kysely'
import { D1Dialect } from 'kysely-d1'
import type { DB } from '~/types/db'

export function createDb(): Kysely<DB> {
  return new Kysely<DB>({
    dialect: new D1Dialect({ database: env.DB }),
  })
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
