import { sql, type Kysely } from 'kysely'
import { afterEach, expect, test, vi } from 'vitest'
import type { DB } from '~/types/db'

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn(
    (_options: { database: { db: Kysely<DB>; type: string } }) => ({}),
  ),
  all: vi.fn(),
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: { prepare: () => ({ bind: () => ({ all: mocks.all }) }) },
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'https://example.com',
  },
}))
vi.mock('better-auth', () => ({ betterAuth: mocks.betterAuth }))
vi.mock('better-auth/plugins', () => ({
  deviceAuthorization: vi.fn(() => ({})),
  emailOTP: vi.fn(() => ({})),
  jwt: vi.fn(() => ({})),
  lastLoginMethod: vi.fn(() => ({})),
}))
vi.mock('@better-auth/oauth-provider', () => ({
  oauthProvider: vi.fn(() => ({})),
  oauthProviderAuthServerMetadata: vi.fn(),
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('the cached auth database starts a second D1 query while the first is pending', async () => {
  vi.resetModules()
  const { createAuth } = await import('./auth.server')
  const { env } = await import('cloudflare:workers')
  const { d1DatabaseFor } = await import('~/lib/d1-database-registry.server')
  const { d1CompatibilityPlugin } =
    await import('~/lib/d1-compatibility.server')
  const auth = createAuth()
  expect(createAuth()).toBe(auth)
  expect(mocks.betterAuth).toHaveBeenCalledTimes(1)
  const { db, type } = mocks.betterAuth.mock.calls[0]![0].database
  expect(type).toBe('sqlite')
  expect(d1DatabaseFor(db)).toBe(env.DB)
  expect(db.getExecutor().plugins).toContain(d1CompatibilityPlugin)

  const release = deferred()
  const firstStarted = deferred()
  const secondStarted = deferred()
  const result = {
    success: true,
    results: [{ value: 1 }],
    meta: { changes: 0, last_row_id: 0 },
  }
  mocks.all
    .mockImplementationOnce(async () => {
      firstStarted.resolve()
      await release.promise
      return result
    })
    .mockImplementationOnce(async () => {
      secondStarted.resolve()
      return result
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('D1 query did not start concurrently')),
      1000,
    )
  })
  const first = sql<{ value: number }>`select 1 as value`.execute(db)
  let second: typeof first | undefined
  try {
    await Promise.race([firstStarted.promise, deadline])
    second = sql<{ value: number }>`select 1 as value`.execute(db)
    await Promise.race([secondStarted.promise, deadline])
    expect(mocks.all).toHaveBeenCalledTimes(2)
    expect(db.getExecutor().adapter.supportsMultipleConnections).toBe(true)
  } finally {
    clearTimeout(timer)
    release.resolve()
    try {
      const results = await Promise.all([first, ...(second ? [second] : [])])
      for (const queryResult of results)
        expect(queryResult.rows).toEqual([{ value: 1 }])
    } finally {
      await db.destroy()
    }
  }
})
