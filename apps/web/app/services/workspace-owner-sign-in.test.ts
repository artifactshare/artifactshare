import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest'
import { upgradeEnvironment } from '~/test/better-auth-upgrade-fixture'
import { d1OnSqlite } from '~/test/d1-on-sqlite'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import * as batches from '~/lib/d1-batch.server'
import * as team from '~/services/team-management.server'
import * as claims from '~/services/workspace-domain-claims.server'
import { createAuth, getSessionUserFromBearer } from '~/services/auth.server'
import { createDb } from '~/services/db.server'

vi.mock('cloudflare:workers', async () => ({
  env: (await import('~/test/better-auth-upgrade-fixture')).upgradeEnvironment,
}))

let db: ReturnType<typeof createDb>
beforeAll(() => {
  const database = d1OnSqlite(createMigratedInMemoryDb().sqlite)
  upgradeEnvironment.DB = database
  db = createDb(database)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  await db?.destroy()
})

async function signIn(email: string) {
  const now = new Date().toISOString()
  await db
    .insertInto('verifications')
    .values({
      id: crypto.randomUUID(),
      identifier: `sign-in-otp-${email}`,
      value: '123456:0',
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      created_at: now,
      updated_at: now,
    })
    .execute()
  return createAuth().handler(
    new Request(
      `${upgradeEnvironment.BETTER_AUTH_URL}/api/auth/sign-in/email-otp`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, otp: '123456' }),
      },
    ),
  )
}

async function userWorkspace(email: string) {
  return db
    .selectFrom('users')
    .select(['id', 'workspace_id'])
    .where('email', '=', email)
    .executeTakeFirstOrThrow()
}

function members(workspace: string) {
  return db
    .selectFrom('workspace_members')
    .select(['user_id', 'role', 'status', 'removed_at', 'removed_by'])
    .where('workspace_id', '=', workspace)
    .orderBy('user_id')
    .execute()
}

async function claimedWorkspace(
  domain: string,
  state: 'owned' | 'removed' | 'member',
) {
  await db
    .insertInto('workspaces')
    .values({ id: domain, name: domain, created_at: '2025' })
    .execute()
  await db
    .insertInto('workspace_domain_claims')
    .values({
      workspace_id: domain,
      domain,
      source: 'google_hd',
      created_at: '2025',
      updated_at: '2025',
    })
    .execute()
  await db
    .insertInto('users')
    .values({
      id: domain,
      email: `previous@${domain}`,
      email_verified: 1,
      workspace_id: domain,
      created_at: '2025',
      updated_at: '2025',
    })
    .execute()
  await db
    .insertInto('workspace_members')
    .values({
      user_id: domain,
      workspace_id: domain,
      role: state === 'member' ? 'member' : 'owner',
      status: state === 'removed' ? 'removed' : 'active',
      removed_at: state === 'removed' ? '2025' : null,
      removed_by: state === 'removed' ? domain : null,
      created_at: '2025',
      updated_at: '2025',
    })
    .execute()
}

// Submit a conflicting statement in the same D1 transaction. The difference
// between an atomic owner insert and a previously committed member is visible
// in the database after the OTP request fails.
function failMembershipBatch() {
  const run = batches.runD1Batch
  return vi
    .spyOn(batches, 'runD1Batch')
    .mockImplementationOnce(async (connection, ...queries) => {
      const duplicate = connection
        .insertInto('workspaces')
        .values({ id: 'batch-conflict', name: 'conflict', created_at: '2025' })
      await run(connection, ...queries, duplicate, duplicate)
    })
}

test.each(['single', 'overlapping'] as const)(
  '%s personal signup commits the active owner in the after-create batch',
  async (attempt) => {
    const email = attempt + '@personal.example'
    let competingWorkspaceId: string | undefined
    if (attempt === 'overlapping') {
      const hooks = createAuth().options.databaseHooks.user.create
      const before = hooks.before
      vi.spyOn(hooks, 'before').mockImplementationOnce(
        async (user, context) => {
          const winning = await before(user, context)
          if (!context) throw new Error('Missing OTP signup context')
          // A second request provisions a different workspace before the winning insert commits.
          const competing = await before(user, {
            ...context,
            path: '/callback/:id',
            params: { id: 'google' },
          })
          competingWorkspaceId = competing.data.workspaceId
          return winning
        },
      )
    }
    const run = batches.runD1Batch
    let beforeBatch
    let committed
    vi.spyOn(batches, 'runD1Batch').mockImplementationOnce(
      async (connection, ...queries) => {
        beforeBatch = await members((await userWorkspace(email)).workspace_id)
        await run(connection, ...queries)
        committed = await members((await userWorkspace(email)).workspace_id)
      },
    )
    expect((await signIn(email)).status).toBe(200)
    const user = await userWorkspace(email)
    if (attempt === 'overlapping') {
      expect(competingWorkspaceId).toBeTypeOf('string')
      expect(competingWorkspaceId).not.toBe(user.workspace_id)
    }
    expect(beforeBatch).toEqual([])
    expect(committed).toEqual([
      expect.objectContaining({
        user_id: user.id,
        role: 'owner',
        status: 'active',
      }),
    ])
  },
)

test.each(['owned', 'removed'] as const)(
  'direct signup joins the %s claimed workspace before session recovery',
  async (state) => {
    const domain = `signup-${state}.example`
    await claimedWorkspace(domain, state)
    const move = claims.maybeMoveUserToClaimedWorkspace
    let afterSignup
    vi.spyOn(claims, 'maybeMoveUserToClaimedWorkspace').mockImplementationOnce(
      async (connection, input) => {
        afterSignup = await members(domain)
        return move(connection, input)
      },
    )
    const email = 'new@' + domain
    expect((await signIn(email)).status).toBe(200)
    const user = await userWorkspace(email)
    expect(user.workspace_id).toBe(domain)
    expect(afterSignup).toEqual(
      expect.arrayContaining([
        {
          user_id: domain,
          role: state === 'owned' ? 'owner' : 'member',
          status: state === 'owned' ? 'active' : 'removed',
          removed_at: state === 'removed' ? '2025' : null,
          removed_by: state === 'removed' ? domain : null,
        },
        expect.objectContaining({
          user_id: user.id,
          role: state === 'owned' ? 'member' : 'owner',
          status: 'active',
        }),
      ]),
    )
  },
)

test('sign-in restores a missing membership after signup into an owned claimed workspace fails', async () => {
  const domain = 'recover-owned-signup.example'
  const email = 'new@' + domain
  await claimedWorkspace(domain, 'owned')
  const before = await members(domain)
  vi.spyOn(team, 'ensureActiveWorkspaceMembership').mockRejectedValueOnce(
    new Error('membership insert failed'),
  )
  expect((await signIn(email)).status).toBe(500)
  const user = await userWorkspace(email)
  expect(user.workspace_id).toBe(domain)
  expect(await members(domain)).toEqual(before)

  expect((await signIn(email)).status).toBe(200)
  const recovered = await members(domain)
  expect(recovered).toHaveLength(2)
  expect(recovered).toEqual(
    expect.arrayContaining([
      ...before,
      expect.objectContaining({
        user_id: user.id,
        role: 'member',
        status: 'active',
      }),
    ]),
  )
})

test('a user with a new domain claim moves at the next sign-in', async () => {
  const domain = 'next-sign-in.example'
  const email = 'new@' + domain
  expect((await signIn(email)).status).toBe(200)
  const user = await userWorkspace(email)
  const session = await db
    .selectFrom('sessions')
    .select('token')
    .where('user_id', '=', user.id)
    .executeTakeFirstOrThrow()
  await claimedWorkspace(domain, 'owned')

  const request = new Request(upgradeEnvironment.BETTER_AUTH_URL, {
    headers: { authorization: `Bearer ${session.token}` },
  })
  expect(await getSessionUserFromBearer(request)).toMatchObject({
    id: user.id,
    workspaceId: user.workspace_id,
  })
  const response = await signIn(email)
  expect(
    await db
      .selectFrom('workspaces')
      .select('id')
      .where('id', '=', user.workspace_id)
      .execute(),
  ).toEqual([])
  expect(response.status).toBe(200)
  expect((await userWorkspace(email)).workspace_id).toBe(domain)
  expect(await members(domain)).toContainEqual(
    expect.objectContaining({
      user_id: user.id,
      role: 'member',
      status: 'active',
    }),
  )
})

test.each(['personal', 'blocked', 'owned', 'removed', 'member'] as const)(
  'the next sign-in recovers a failed signup with a %s destination',
  async (state) => {
    const domain = `recover-${state}.example`
    const email = 'new@' + domain
    const fault = failMembershipBatch()
    expect((await signIn(email)).status).toBe(500)
    expect(fault).toHaveBeenCalled()
    fault.mockRestore()
    const source = await userWorkspace(email)
    expect(await members(source.workspace_id)).toEqual([])
    if (state !== 'personal') {
      await claimedWorkspace(domain, state === 'blocked' ? 'owned' : state)
      if (state === 'blocked')
        await db
          .updateTable('workspaces')
          .set({ name: 'Keep this workspace' })
          .where('id', '=', source.workspace_id)
          .execute()
    }
    expect((await signIn(email)).status).toBe(200)
    const retained = state === 'personal' || state === 'blocked'
    const destination = retained ? source.workspace_id : domain
    expect((await userWorkspace(email)).workspace_id).toBe(destination)
    const rows = await members(destination)
    const moverOwns = retained || state === 'removed'
    expect(rows.find((row) => row.user_id === source.id)).toMatchObject({
      role: moverOwns ? 'owner' : 'member',
      status: 'active',
    })
    expect(
      rows
        .filter((row) => row.role === 'owner' && row.status === 'active')
        .map((row) => row.user_id),
    ).toEqual([moverOwns ? source.id : domain])
    if (state === 'removed')
      expect(rows.find((row) => row.user_id === domain)).toMatchObject({
        role: 'member',
        status: 'removed',
        removed_at: '2025',
        removed_by: domain,
      })
    if (!retained) {
      expect(
        await db
          .selectFrom('workspaces')
          .select('id')
          .where('id', '=', source.workspace_id)
          .execute(),
      ).toEqual([])
      expect(await members(source.workspace_id)).toEqual([])
    }
    expect(
      await db
        .selectFrom('pending_signup_analytics')
        .select('workspace_created')
        .where('user_id', '=', source.id)
        .executeTakeFirst(),
    ).toEqual({ workspace_created: retained ? 1 : 0 })
  },
)

test('a committed claim move keeps its signup attribution when destination repair needs a retry', async () => {
  const domain = 'retry-move.example'
  const email = 'new@' + domain
  expect((await signIn(email)).status).toBe(200)
  const source = await userWorkspace(email)
  await claimedWorkspace(domain, 'removed')
  vi.spyOn(team, 'ensureWorkspaceAdmin').mockRejectedValueOnce(
    new Error('destination repair failed'),
  )
  expect((await signIn(email)).status).toBe(500)
  expect((await userWorkspace(email)).workspace_id).toBe(domain)
  expect(
    (await members(domain)).filter(
      (row) => row.role === 'owner' && row.status === 'active',
    ),
  ).toEqual([])
  const attribution = db
    .selectFrom('pending_signup_analytics')
    .select('workspace_created')
    .where('user_id', '=', source.id)
  expect(await attribution.executeTakeFirst()).toEqual({ workspace_created: 0 })
  expect((await signIn(email)).status).toBe(200)
  expect(await members(domain)).toContainEqual(
    expect.objectContaining({
      user_id: source.id,
      role: 'owner',
      status: 'active',
    }),
  )
  expect(await attribution.executeTakeFirst()).toEqual({ workspace_created: 0 })
})

test('failed replacement leaves the removed owner slot intact until a successful sign-in', async () => {
  const email = 'new@retained.example'
  expect((await signIn(email)).status).toBe(200)
  const user = await userWorkspace(email)
  await db
    .insertInto('users')
    .values({
      id: 'removed-owner',
      workspace_id: user.workspace_id,
      email: 'former@retained.example',
      email_verified: 1,
      created_at: '2025',
      updated_at: '2025',
    })
    .execute()
  await db
    .updateTable('workspace_members')
    .set({ role: 'member' })
    .where('user_id', '=', user.id)
    .execute()
  await db
    .insertInto('workspace_members')
    .values({
      workspace_id: user.workspace_id,
      user_id: 'removed-owner',
      role: 'owner',
      status: 'removed',
      removed_at: '2025',
      removed_by: 'removed-owner',
      created_at: '2025',
      updated_at: '2025',
    })
    .execute()
  const before = await members(user.workspace_id)
  const fault = failMembershipBatch()
  expect((await signIn(email)).status).toBe(500)
  expect(await members(user.workspace_id)).toEqual(before)
  fault.mockRestore()
  expect((await signIn(email)).status).toBe(200)
  expect(await members(user.workspace_id)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        user_id: user.id,
        role: 'owner',
        status: 'active',
      }),
      expect.objectContaining({
        user_id: 'removed-owner',
        role: 'member',
        status: 'removed',
        removed_at: '2025',
        removed_by: 'removed-owner',
      }),
    ]),
  )
})
