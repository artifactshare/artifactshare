import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: (() => {
    const batchDb = createD1BatchDbMock({ sqlite: sqliteRef })
    return {
      DB: {
        prepare: (sql: string) => ({
          bind: (...params: unknown[]) => ({
            sql,
            params,
            all: async () => {
              const sqlite = sqliteRef.current
              if (!sqlite) throw new Error('sqlite not bound in test')
              const statement = sqlite.prepare(sql)
              const isQuery = /\bRETURNING\b|^\s*(SELECT|WITH|PRAGMA)/i.test(
                sql,
              )
              const rows = isQuery
                ? statement.all(...(params as never[]))
                : (statement.run(...(params as never[])), [])
              return {
                results: rows,
                success: true,
                meta: { changes: 0, last_row_id: null },
              }
            },
            run: async () => {
              const sqlite = sqliteRef.current
              if (!sqlite) throw new Error('sqlite not bound in test')
              const result = sqlite.prepare(sql).run(...(params as never[]))
              return {
                success: true,
                meta: {
                  changes: Number(result.changes),
                  last_row_id: Number(result.lastInsertRowid),
                },
              }
            },
          }),
        }),
        batch: batchDb.batch,
      },
      BETTER_AUTH_SECRET: 'test-secret',
      BETTER_AUTH_URL: 'https://example.com',
      GOOGLE_CLIENT_ID: 'test-google-client-id',
      GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
      MICROSOFT_CLIENT_ID: 'test-microsoft-client-id',
      MICROSOFT_CLIENT_SECRET: 'test-microsoft-client-secret',
    }
  })(),
}))

import { runWithEndpointContext } from '@better-auth/core/context'
import { createAuth } from './auth.server'
import { ensureWorkspaceDomainClaim } from './workspace-domain-claims.server'

const NOW = '2026-06-26T00:00:00.000Z'

function createGoogleIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  )
  return `${header}.${body}.sig`
}

type AuthContext = {
  socialProviders: Array<{
    id: string
    getUserInfo: (tokens: { idToken: string }) => Promise<{
      user: Record<string, unknown>
    } | null>
  }>
  internalAdapter: {
    createUser: (user: Record<string, unknown>) => Promise<{ id: string }>
    createAccount: (account: Record<string, unknown>) => Promise<unknown>
  }
}

async function getAuthContext(): Promise<AuthContext> {
  const auth = createAuth() as unknown as {
    $context: Promise<AuthContext>
  }
  return await auth.$context
}

async function createGoogleUserThroughCallback(
  context: AuthContext,
  payload: Record<string, unknown>,
): Promise<{ id: string; idToken: string }> {
  const idToken = createGoogleIdToken(payload)
  const google = context.socialProviders.find(
    (provider) => provider.id === 'google',
  )
  expect(google).toBeDefined()

  const mapped = await google!.getUserInfo({ idToken })
  expect(mapped?.user).toMatchObject({
    email: payload.email,
    emailVerified: true,
  })
  expect(mapped?.user).not.toHaveProperty('_hd')
  expect(mapped?.user).not.toHaveProperty('_authRoute')

  const id = await runWithEndpointContext(
    {
      path: '/callback/:id',
      params: { id: 'google' },
      context: context as any,
    },
    async () => {
      const user = await context.internalAdapter.createUser(mapped!.user)
      await context.internalAdapter.createAccount({
        userId: user.id,
        providerId: 'google',
        accountId: payload.sub,
        idToken,
      })
      return user.id
    },
  )

  return { id, idToken }
}

async function seedClaim(
  db: ReturnType<typeof createMigratedInMemoryDb>['db'],
  workspaceId: string,
  domain = 'corp.com',
) {
  await db
    .insertInto('workspaces')
    .values({
      id: workspaceId,
      hd: null,
      name: domain,
      created_at: NOW,
      email_domain: domain,
      self_upload_enabled: 1,
    })
    .execute()
  await ensureWorkspaceDomainClaim(db, {
    domain,
    workspaceId,
    source: 'google_hd',
    now: NOW,
  })
}

async function expectUserWorkspaceMember(
  db: ReturnType<typeof createMigratedInMemoryDb>['db'],
  userId: string,
  workspaceId: string,
  role: 'owner' | 'member',
) {
  await expect(
    db
      .selectFrom('users')
      .select('workspace_id')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({ workspace_id: workspaceId })
  await expect(
    db
      .selectFrom('workspace_members')
      .select(['user_id', 'role', 'status'])
      .where('workspace_id', '=', workspaceId)
      .where('user_id', '=', userId)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow(),
  ).resolves.toEqual({ user_id: userId, role, status: 'active' })
}

describe('Better Auth OAuth workspace integration', () => {
  let fixture: ReturnType<typeof createMigratedInMemoryDb> | null = null

  afterEach(async () => {
    await fixture?.db.destroy()
    fixture = null
    sqliteRef.current = null
  })

  test('Google hd joins an existing claim through profile mapping and hooks', async () => {
    fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqliteRef.current = fixture.sqlite
    const { db } = fixture
    await seedClaim(db, 'ws-existing-hd')

    const { id: userId, idToken } = await createGoogleUserThroughCallback(
      await getAuthContext(),
      {
        sub: 'google-sub-hd',
        email: 'alice@corp.com',
        email_verified: true,
        hd: 'corp.com',
        name: 'Alice',
      },
    )

    await expectUserWorkspaceMember(db, userId, 'ws-existing-hd', 'owner')
    await expect(
      db
        .selectFrom('accounts')
        .select(['user_id', 'provider_id', 'id_token'])
        .execute(),
    ).resolves.toEqual([
      { user_id: userId, provider_id: 'google', id_token: idToken },
    ])
  })

  test('Google without hd matches an existing claim through the account hook', async () => {
    fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqliteRef.current = fixture.sqlite
    const { db } = fixture
    await seedClaim(db, 'ws-existing-no-hd')

    const { id: userId } = await createGoogleUserThroughCallback(
      await getAuthContext(),
      {
        sub: 'google-sub-no-hd',
        email: 'alice@corp.com',
        email_verified: true,
        name: 'Alice',
      },
    )

    await expectUserWorkspaceMember(db, userId, 'ws-existing-no-hd', 'owner')
  })

  test('Google new hd creates a claim workspace and moves the user in the account hook', async () => {
    fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqliteRef.current = fixture.sqlite
    const { db } = fixture

    const { id: userId } = await createGoogleUserThroughCallback(
      await getAuthContext(),
      {
        sub: 'google-sub-new-hd',
        email: 'alice@newcorp.com',
        email_verified: true,
        hd: 'newcorp.com',
        name: 'Alice',
      },
    )

    const claim = await db
      .selectFrom('workspace_domain_claims')
      .select(['domain', 'workspace_id'])
      .where('domain', '=', 'newcorp.com')
      .executeTakeFirstOrThrow()
    await expectUserWorkspaceMember(db, userId, claim.workspace_id, 'owner')
    expect(claim.domain).toBe('newcorp.com')
    await expect(
      db
        .selectFrom('workspaces')
        .select(({ fn }) => fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 })
  })

  test('Google hd takes precedence over a different claimed email domain', async () => {
    fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqliteRef.current = fixture.sqlite
    const { db } = fixture
    await seedClaim(db, 'ws-email-domain', 'alias.example')
    await seedClaim(db, 'ws-hosted-domain', 'corp.com')

    const { id: userId } = await createGoogleUserThroughCallback(
      await getAuthContext(),
      {
        sub: 'google-sub-alias',
        email: 'alice@alias.example',
        email_verified: true,
        hd: 'corp.com',
        name: 'Alice',
      },
    )

    await expectUserWorkspaceMember(db, userId, 'ws-hosted-domain', 'owner')
  })

  test('email code first login stays in a viewer workspace without claim membership', async () => {
    fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqliteRef.current = fixture.sqlite
    const { db } = fixture
    await seedClaim(db, 'ws-claimed')
    const context = await getAuthContext()

    const userId = await runWithEndpointContext(
      {
        path: '/sign-in/email-otp',
        params: {},
        context: context as any,
      },
      async () => {
        const user = await context.internalAdapter.createUser({
          email: 'viewer@corp.com',
          emailVerified: true,
          name: 'Viewer',
        })
        return user.id
      },
    )

    const user = await db
      .selectFrom('users')
      .select('workspace_id')
      .where('id', '=', userId)
      .executeTakeFirstOrThrow()
    expect(user.workspace_id).not.toBe('ws-claimed')
    await expectUserWorkspaceMember(db, userId, user.workspace_id, 'owner')
    await expect(
      db
        .selectFrom('workspace_members')
        .select('user_id')
        .where('workspace_id', '=', 'ws-claimed')
        .where('user_id', '=', userId)
        .where('status', '=', 'active')
        .execute(),
    ).resolves.toEqual([])
    await expect(
      db
        .selectFrom('workspaces')
        .select('self_upload_enabled')
        .where('id', '=', user.workspace_id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ self_upload_enabled: 0 })
  })
})
