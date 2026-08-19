import type { Kysely } from 'kysely'
import type { DB } from '~/types/db'

const d1Databases = new WeakMap<Kysely<DB>, D1Database>()

export function associateD1Database(
  db: Kysely<DB>,
  database: D1Database,
): void {
  d1Databases.set(db, database)
}

export function d1DatabaseFor(db: Kysely<DB>): D1Database | undefined {
  return d1Databases.get(db)
}
