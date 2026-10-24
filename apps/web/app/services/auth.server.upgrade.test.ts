import { DatabaseSync } from 'node:sqlite'
import { afterAll, test, vi } from 'vitest'
import {
  applyPreUpgradeSchema,
  assertBetterAuthUpgrade,
  upgradeEnvironment,
} from '../test/better-auth-upgrade-fixture'
import { createD1MockFromSqliteRef } from '../test/sqlite-fixture'

vi.mock('cloudflare:workers', async () => ({
  env: (await import('../test/better-auth-upgrade-fixture')).upgradeEnvironment,
}))
import { createAuth } from './auth.server'

const sqlite = new DatabaseSync(':memory:')
const database = createD1MockFromSqliteRef({
  current: sqlite,
}) as unknown as D1Database
upgradeEnvironment.DB = database

afterAll(() => {
  vi.unstubAllGlobals()
  sqlite.close()
})
test('migrated 1.6 fixtures pass the 1.7 schema check, sign in and refresh', async () => {
  await applyPreUpgradeSchema(database, async (sql) => sqlite.exec(sql))
  await assertBetterAuthUpgrade(database, createAuth)
})
