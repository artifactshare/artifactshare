import { readFile } from 'node:fs/promises'
import { unstable_splitSqlQuery } from 'wrangler'

// Viewer scenarios need the current schema in a fresh D1 database, not a walk
// through migration history. check-schema compares this schema with the rebuild
// baseline and all later migrations; D1/integration suites retain that coverage.
export async function applyBrowserFixtureSchema(database: D1Database) {
  const schema = await readFile(
    new URL('../../db/schema.sql', import.meta.url),
    'utf8',
  )
  await database.batch(
    // D1 already enforces foreign keys and does not allow this SQLite setter.
    unstable_splitSqlQuery(
      schema.replace(/^PRAGMA foreign_keys = ON;$/m, ''),
    ).map((sql) => database.prepare(sql)),
  )
}
