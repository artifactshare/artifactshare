import { fileURLToPath } from 'node:url'
import { createTestHarness } from 'wrangler'
import { afterAll, beforeAll, expect, test, vi } from 'vitest'
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

// Sign-in consumes the code with an atomic delete, then writes it back when a
// guess is wrong. Only a real D1 shows that the adapter supports both.
test('email OTP sign-in counts wrong codes and accepts a code once on D1', async () => {
  const email = 'otp-viewer@example.com'
  const identifier = `sign-in-otp-${email}`
  const seed = () =>
    database
      .prepare(
        `INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at)
         VALUES (?1, ?2, '123456:0', ?3, ?4, ?4)`,
      )
      .bind(
        crypto.randomUUID(),
        identifier,
        new Date(Date.now() + 600_000).toISOString(),
        new Date().toISOString(),
      )
      .run()
  const attempt = (otp: string) =>
    createAuth().handler(
      new Request(
        `${upgradeEnvironment.BETTER_AUTH_URL}/api/auth/sign-in/email-otp`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, otp }),
        },
      ),
    )
  const storedValue = () =>
    database
      .prepare('SELECT value FROM verifications WHERE identifier = ?1')
      .bind(identifier)
      .first<string>('value')

  await seed()
  expect((await attempt('000000')).status).toBe(400)
  expect(await storedValue()).toBe('123456:1')

  const accepted = await Promise.all([attempt('123456'), attempt('123456')])
  expect(accepted.map((response) => response.status).sort()).toEqual([200, 400])
  expect(await storedValue()).toBeNull()

  await seed()
  for (let attempts = 1; attempts <= 5; attempts += 1)
    expect((await attempt('000000')).status).toBe(400)
  expect(await storedValue()).toBe('123456:5')
  expect((await attempt('123456')).status).toBe(403)
  expect(await storedValue()).toBeNull()
})
