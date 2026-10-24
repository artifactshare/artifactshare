import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, test, vi } from 'vitest'
import {
  applyPreUpgradeSchema,
  assertBetterAuthUpgrade,
  upgradeEnvironment,
} from '../test/better-auth-upgrade-fixture'

vi.mock('cloudflare:workers', async () => ({
  env: (await import('../test/better-auth-upgrade-fixture')).upgradeEnvironment,
}))
import { createAuth } from '../services/auth.server'

const server = createTestHarness({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  workers: [{ configPath: './wrangler.sandbox.jsonc' }],
})
const worker = server.getWorker<{ DB: D1Database }>()
let database: D1Database
beforeAll(async () => {
  await server.listen()
  database = (await worker.getEnv()).DB
  upgradeEnvironment.DB = database
  await applyPreUpgradeSchema(database)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await server.close()
})
test('1.6 identities, refresh credentials and device codes survive the D1 upgrade', async () => {
  await assertBetterAuthUpgrade(database, createAuth)
})
