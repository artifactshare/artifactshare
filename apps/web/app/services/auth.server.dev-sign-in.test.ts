import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  createD1MockFromSqliteRef,
  createMigratedInMemoryDb,
} from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { LINK_SHARING_PLAN_DEFAULTS } from '~/lib/link-sharing-policy'
import {
  PLAN_STORAGE_QUOTA_BYTES,
  type BillingPlan,
} from '~/lib/billing-plan.server'

const testRefs = vi.hoisted(() => ({
  authSecret: 'test-secret-with-enough-entropy-for-dev-sign-in',
  sqliteRef: { current: null as DatabaseSync | null },
  googleClientId: 'test-google-client-id',
  googleClientSecret: 'test-google-client-secret',
  microsoftClientId: 'test-microsoft-client-id',
  microsoftClientSecret: 'test-microsoft-client-secret',
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1MockFromSqliteRef(testRefs.sqliteRef),
    BETTER_AUTH_SECRET: testRefs.authSecret,
    BETTER_AUTH_URL: 'https://example.com',
    get GOOGLE_CLIENT_ID() {
      return testRefs.googleClientId
    },
    get GOOGLE_CLIENT_SECRET() {
      return testRefs.googleClientSecret
    },
    get MICROSOFT_CLIENT_ID() {
      return testRefs.microsoftClientId
    },
    get MICROSOFT_CLIENT_SECRET() {
      return testRefs.microsoftClientSecret
    },
  },
}))

import {
  createAuth,
  DEV_SIGN_IN_ADMIN_EMAIL,
  DEV_SIGN_IN_MEMBER_EMAIL,
  DEV_SIGN_IN_WORKSPACE_NAME,
  ensureDevSignInUser,
  getSessionUser,
} from './auth.server'

describe('ensureDevSignInUser', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    testRefs.sqliteRef.current = sqlite
    testRefs.googleClientId = 'test-google-client-id'
    testRefs.googleClientSecret = 'test-google-client-secret'
    testRefs.microsoftClientId = 'test-microsoft-client-id'
    testRefs.microsoftClientSecret = 'test-microsoft-client-secret'
  })

  afterEach(async () => {
    testRefs.sqliteRef.current = null
    await db.destroy()
  })

  test('creates the four personas across three workspaces with product defaults', async () => {
    const personas = [
      'free-owner',
      'plus-owner',
      'team-owner',
      'team-member',
    ] as const
    const userIds: string[] = []
    for (const persona of personas) {
      userIds.push((await ensureDevSignInUser(db, persona)).userId)
    }
    const users = await db.selectFrom('users').selectAll().execute()
    const workspaces = await db.selectFrom('workspaces').selectAll().execute()
    const memberships = await db
      .selectFrom('workspace_members')
      .selectAll()
      .execute()

    expect(userIds).toHaveLength(4)
    expect(users).toHaveLength(4)
    expect(workspaces).toHaveLength(3)
    expect(new Set(users.map((user) => user.workspace_id)).size).toBe(3)

    for (const workspace of workspaces) {
      const plan = workspace.plan as BillingPlan
      const defaults = LINK_SHARING_PLAN_DEFAULTS[plan]
      expect(workspace.storage_quota_bytes).toBe(PLAN_STORAGE_QUOTA_BYTES[plan])
      expect(workspace.link_sharing_enabled).toBe(
        defaults.linkSharingEnabled ? 1 : 0,
      )
      expect(workspace.external_posting_enabled).toBe(
        defaults.externalPostingEnabled ? 1 : 0,
      )
      expect(workspace.link_expiry_default_days).toBe(
        defaults.linkExpiryDefaultDays,
      )
      expect(workspace.link_expiry_max_days).toBe(defaults.linkExpiryMaxDays)
    }

    expect(memberships.map((membership) => membership.role).sort()).toEqual([
      'member',
      'owner',
      'owner',
      'owner',
    ])
    expect(
      users.find((user) => user.email === DEV_SIGN_IN_MEMBER_EMAIL)
        ?.workspace_id,
    ).toBe(
      users.find((user) => user.email === DEV_SIGN_IN_ADMIN_EMAIL)
        ?.workspace_id,
    )
  })

  test('preserves manually changed Team policy on later persona sign-in', async () => {
    await ensureDevSignInUser(db, 'team-owner')
    const team = await db
      .selectFrom('workspaces')
      .select('id')
      .where('name', '=', DEV_SIGN_IN_WORKSPACE_NAME)
      .executeTakeFirstOrThrow()
    await db
      .updateTable('workspaces')
      .set({
        plan: 'team',
        storage_quota_bytes: 123,
        link_sharing_enabled: 1,
        external_posting_enabled: 0,
        link_expiry_default_days: 7,
        link_expiry_max_days: 14,
      })
      .where('id', '=', team.id)
      .execute()

    await ensureDevSignInUser(db, 'team-member')
    await ensureDevSignInUser(db, 'team-owner')
    expect(
      await db
        .selectFrom('workspaces')
        .selectAll()
        .where('id', '=', team.id)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      plan: 'team',
      storage_quota_bytes: 123,
      link_sharing_enabled: 1,
      external_posting_enabled: 0,
      link_expiry_default_days: 7,
      link_expiry_max_days: 14,
    })
  })

  test('creates a shared workspace with hd null and admin in workspace_members', async () => {
    const adminId = (await ensureDevSignInUser(db, 'team-owner')).userId

    const admin = await db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow()
    const workspace = await db
      .selectFrom('workspaces')
      .selectAll()
      .where('id', '=', admin.workspace_id)
      .executeTakeFirstOrThrow()
    const adminRow = await db
      .selectFrom('workspace_members')
      .selectAll()
      .where('workspace_id', '=', workspace.id)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow()

    expect(admin.email).toBe(DEV_SIGN_IN_ADMIN_EMAIL)
    expect(workspace.name).toBe(DEV_SIGN_IN_WORKSPACE_NAME)
    expect(workspace.hd).toBeNull()
    expect(workspace.self_upload_enabled).toBe(1)
    expect(adminRow.user_id).toBe(adminId)
  })

  test('reuses the same workspace for member and keeps member out of workspace admin role', async () => {
    const adminId = (await ensureDevSignInUser(db, 'team-owner')).userId
    const memberId = (await ensureDevSignInUser(db, 'team-member')).userId

    const admin = await db
      .selectFrom('users')
      .select('workspace_id')
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow()
    const member = await db
      .selectFrom('users')
      .select(['workspace_id', 'email'])
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow()
    const adminRow = await db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', admin.workspace_id)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow()
    const memberRow = await db
      .selectFrom('workspace_members')
      .select('role')
      .where('workspace_id', '=', admin.workspace_id)
      .where('user_id', '=', memberId)
      .executeTakeFirst()

    expect(member.workspace_id).toBe(admin.workspace_id)
    expect(member.email).toBe(DEV_SIGN_IN_MEMBER_EMAIL)
    expect(adminRow.user_id).toBe(adminId)
    expect(memberRow?.role).toBe('member')
  })

  test('creates the admin row even when member signs in first', async () => {
    const memberId = (await ensureDevSignInUser(db, 'team-member')).userId

    const member = await db
      .selectFrom('users')
      .select('workspace_id')
      .where('id', '=', memberId)
      .executeTakeFirstOrThrow()
    const admin = await db
      .selectFrom('users')
      .select(['id', 'workspace_id'])
      .where('email', '=', DEV_SIGN_IN_ADMIN_EMAIL)
      .executeTakeFirstOrThrow()
    const adminRow = await db
      .selectFrom('workspace_members')
      .select('user_id')
      .where('workspace_id', '=', member.workspace_id)
      .where('role', '=', 'owner')
      .executeTakeFirstOrThrow()

    expect(admin.workspace_id).toBe(member.workspace_id)
    expect(adminRow.user_id).toBe(admin.id)
    expect(adminRow.user_id).not.toBe(memberId)
  })

  test('does not reuse an unrelated workspace with the same display name', async () => {
    const unrelatedWorkspaceId = 'existing-workspace'
    await db
      .insertInto('workspaces')
      .values({
        id: unrelatedWorkspaceId,
        hd: null,
        name: DEV_SIGN_IN_WORKSPACE_NAME,
        created_at: '2026-01-01T00:00:00.000Z',
      })
      .execute()

    const adminId = (await ensureDevSignInUser(db, 'team-owner')).userId

    const admin = await db
      .selectFrom('users')
      .select('workspace_id')
      .where('id', '=', adminId)
      .executeTakeFirstOrThrow()
    const unrelatedUsers = await db
      .selectFrom('users')
      .select('id')
      .where('workspace_id', '=', unrelatedWorkspaceId)
      .execute()

    expect(admin.workspace_id).not.toBe(unrelatedWorkspaceId)
    expect(unrelatedUsers).toHaveLength(0)
  })

  test('is idempotent and does not create duplicate workspaces or users', async () => {
    await ensureDevSignInUser(db, 'team-owner')
    await ensureDevSignInUser(db, 'team-member')
    await ensureDevSignInUser(db, 'team-owner')
    await ensureDevSignInUser(db, 'team-member')

    const workspaces = await db
      .selectFrom('workspaces')
      .select('id')
      .where('name', '=', DEV_SIGN_IN_WORKSPACE_NAME)
      .execute()
    const users = await db
      .selectFrom('users')
      .select('email')
      .where('email', 'in', [DEV_SIGN_IN_ADMIN_EMAIL, DEV_SIGN_IN_MEMBER_EMAIL])
      .execute()

    expect(workspaces).toHaveLength(1)
    expect(users).toHaveLength(2)
  })

  test('isolates and idempotently seeds screen capture scenarios', async () => {
    const homeUserId = (
      await ensureDevSignInUser(db, 'free-owner', 'home/content-rich')
    ).userId
    const recentUserId = (
      await ensureDevSignInUser(db, 'free-owner', 'recent/content-rich')
    ).userId
    await ensureDevSignInUser(db, 'free-owner', 'home/content-rich')
    await ensureDevSignInUser(db, 'free-owner', 'recent/content-rich')

    const scenarioUsers = await db
      .selectFrom('users')
      .select(['id', 'email', 'workspace_id'])
      .where('id', 'in', [homeUserId, recentUserId])
      .execute()
    expect(homeUserId).not.toBe(recentUserId)
    const homeWorkspaceId = scenarioUsers.find(
      (user) => user.id === homeUserId,
    )?.workspace_id
    const recentWorkspaceId = scenarioUsers.find(
      (user) => user.id === recentUserId,
    )?.workspace_id
    expect(homeWorkspaceId).toBeDefined()
    expect(recentWorkspaceId).toBeDefined()
    expect(homeWorkspaceId).not.toBe(recentWorkspaceId)
    expect(scenarioUsers.every((user) => user.email.includes('+'))).toBe(true)
    const scenarioFileCounts = await Promise.all(
      [homeWorkspaceId, recentWorkspaceId].map(async (workspaceId) => {
        const row = await db
          .selectFrom('shareables')
          .select((eb) => eb.fn.countAll<number>().as('count'))
          .where('workspace_id', '=', workspaceId!)
          .executeTakeFirstOrThrow()
        return Number(row.count)
      }),
    )
    expect(scenarioFileCounts).toEqual([4, 24])
    const joinedWorkspaceId = `${recentWorkspaceId}-recent-joined-workspace`
    const joinedFileId = `${joinedWorkspaceId}-project-file`
    expect(
      await db
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', joinedWorkspaceId)
        .execute(),
    ).toEqual([{ id: joinedWorkspaceId }])
    expect(
      await db
        .selectFrom('shareables')
        .select(['id', 'workspace_id'])
        .where('id', '=', joinedFileId)
        .execute(),
    ).toEqual([{ id: joinedFileId, workspace_id: joinedWorkspaceId }])
    expect(
      await db
        .selectFrom('shareables')
        .select('workspace_id')
        .where('workspace_id', '=', homeWorkspaceId!)
        .execute(),
    ).toEqual([
      { workspace_id: homeWorkspaceId },
      { workspace_id: homeWorkspaceId },
      { workspace_id: homeWorkspaceId },
      { workspace_id: homeWorkspaceId },
    ])
    expect(
      await db.selectFrom('workspaces').select('id').execute(),
    ).toHaveLength(3)
  })

  test('shares project containers across personas in the same scenario workspace', async () => {
    const owner = await ensureDevSignInUser(
      db,
      'team-owner',
      'project-detail/with-files',
    )
    const member = await ensureDevSignInUser(
      db,
      'team-member',
      'project-detail/with-files',
    )

    expect(owner.workspaceId).toBe(member.workspaceId)
    expect(owner.containerId).toBe(member.containerId)
    expect(
      await db
        .selectFrom('artifact_containers')
        .select('id')
        .where('workspace_id', '=', owner.workspaceId)
        .where('kind', '=', 'project')
        .execute(),
    ).toHaveLength(1)
    const projectFiles = await db
      .selectFrom('shareables')
      .select(['name', 'visibility'])
      .where('container_id', '=', owner.containerId)
      .execute()
    expect(projectFiles).toHaveLength(3)
    expect(new Set(projectFiles.map((file) => file.name)).size).toBe(3)
    expect(projectFiles.every((file) => file.visibility === 'project')).toBe(
      true,
    )
  })

  test('seeds the created token scenario consistently', async () => {
    const userId = (
      await ensureDevSignInUser(
        db,
        'team-owner',
        'settings-tokens/created-secret',
      )
    ).userId

    expect(
      await db
        .selectFrom('api_tokens')
        .select(['name', 'revoked_at'])
        .where('user_id', '=', userId)
        .execute(),
    ).toEqual([{ name: 'CLI deploy', revoked_at: null }])
  })

  test('isolates the owner associated with a member scenario', async () => {
    const regularOwnerId = (await ensureDevSignInUser(db, 'team-owner')).userId
    const regularOwner = await db
      .selectFrom('users')
      .select('workspace_id')
      .where('id', '=', regularOwnerId)
      .executeTakeFirstOrThrow()

    await ensureDevSignInUser(db, 'team-member', 'home/content-rich')

    expect(
      await db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', regularOwnerId)
        .executeTakeFirstOrThrow(),
    ).toEqual(regularOwner)
    expect(
      await db
        .selectFrom('users')
        .select('email')
        .where(
          'email',
          '=',
          'dev-team-owner+home-content-rich@artifactshare.local',
        )
        .executeTakeFirst(),
    ).toBeDefined()
  })

  test('keeps team membership stable when personas sign in in changing order', async () => {
    const ownerId = (
      await ensureDevSignInUser(db, 'team-owner', 'recent/content-rich')
    ).userId
    const memberId = (
      await ensureDevSignInUser(db, 'team-member', 'recent/content-rich')
    ).userId
    await ensureDevSignInUser(db, 'team-owner', 'recent/content-rich')

    const users = await db
      .selectFrom('users')
      .select(['id', 'workspace_id'])
      .where('id', 'in', [ownerId, memberId])
      .execute()
    expect(users[0]?.workspace_id).toBe(users[1]?.workspace_id)
    expect(
      await db
        .selectFrom('workspace_members')
        .select(['user_id', 'role'])
        .where('workspace_id', '=', users[0]?.workspace_id ?? '')
        .where('user_id', 'in', [ownerId, memberId])
        .execute(),
    ).toEqual(
      expect.arrayContaining([
        { user_id: ownerId, role: 'owner' },
        { user_id: memberId, role: 'member' },
      ]),
    )
  })

  test('keeps scenario artifact ownership isolated when owners sign in in changing order', async () => {
    const freeOwnerId = (
      await ensureDevSignInUser(db, 'free-owner', 'recent/content-rich')
    ).userId
    const teamOwnerId = (
      await ensureDevSignInUser(db, 'team-owner', 'recent/content-rich')
    ).userId

    for (const userId of [freeOwnerId, teamOwnerId]) {
      const row = await db
        .selectFrom('shareables')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .where('owner_user_id', '=', userId)
        .executeTakeFirstOrThrow()
      expect(Number(row.count)).toBe(23)
    }
  })

  test('keeps scenario tokens owned by each persona when sign-in order changes', async () => {
    const memberId = (
      await ensureDevSignInUser(
        db,
        'team-member',
        'settings-tokens/created-secret',
      )
    ).userId
    const ownerId = (
      await ensureDevSignInUser(
        db,
        'team-owner',
        'settings-tokens/created-secret',
      )
    ).userId

    for (const userId of [memberId, ownerId]) {
      expect(
        await db
          .selectFrom('api_tokens')
          .select(['user_id', 'token_hash'])
          .where('user_id', '=', userId)
          .execute(),
      ).toEqual([
        { user_id: userId, token_hash: expect.stringContaining(userId) },
      ])
    }
  })

  test('keeps billing subscriptions unique when personas sign in in changing order', async () => {
    for (const persona of ['free-owner', 'plus-owner', 'team-owner'] as const) {
      await ensureDevSignInUser(db, persona, 'settings-billing/subscribed')
    }

    const workspaces = await db
      .selectFrom('users')
      .innerJoin('workspaces', 'workspaces.id', 'users.workspace_id')
      .select([
        'workspaces.id',
        'workspaces.stripe_subscription_id',
        'workspaces.stripe_subscription_status',
      ])
      .where(
        'users.email',
        'like',
        'dev-%+settings-billing-subscribed@artifactshare.local',
      )
      .distinct()
      .execute()
    expect(workspaces).toHaveLength(3)
    expect(
      workspaces.every(
        (workspace) => workspace.stripe_subscription_status === 'active',
      ),
    ).toBe(true)
    expect(
      new Set(workspaces.map((workspace) => workspace.stripe_subscription_id))
        .size,
    ).toBe(3)
  })
})

describe('/api/auth/dev/sign-in', () => {
  let sqlite: DatabaseSync
  let db: Kysely<DB>

  beforeEach(() => {
    const fixture = createMigratedInMemoryDb()
    sqlite = fixture.sqlite
    db = fixture.db
    testRefs.sqliteRef.current = sqlite
    testRefs.googleClientId = 'test-google-client-id'
    testRefs.googleClientSecret = 'test-google-client-secret'
    testRefs.microsoftClientId = 'test-microsoft-client-id'
    testRefs.microsoftClientSecret = 'test-microsoft-client-secret'
  })

  afterEach(async () => {
    testRefs.sqliteRef.current = null
    await db.destroy()
  })

  test.each(['free-owner', 'plus-owner', 'team-owner', 'team-member'] as const)(
    'returns a session for %s',
    async (persona) => {
      const response = await createAuth().handler(
        new Request('https://example.com/api/auth/dev/sign-in', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ persona }),
        }),
      )

      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({
        ok: true,
        userId: expect.any(String),
        workspaceId: expect.any(String),
        containerId: null,
      })
      expect(response.headers.get('set-cookie')).toMatch(
        /better-auth\.session_token=/,
      )
    },
  )

  test('issues a dev session when social provider credentials are absent', async () => {
    testRefs.googleClientId = ''
    testRefs.googleClientSecret = ''
    testRefs.microsoftClientId = ''
    testRefs.microsoftClientSecret = ''

    const response = await createAuth().handler(
      new Request('https://example.com/api/auth/dev/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ persona: 'plus-owner' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toMatch(
      /better-auth\.session_token=/,
    )
  })

  test('returns Set-Cookie for admin sign-in', async () => {
    const response = await createAuth().handler(
      new Request('https://example.com/api/auth/dev/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ persona: 'team-owner' }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      ok: true,
      userId: expect.any(String),
      workspaceId: expect.any(String),
      containerId: null,
    })
    expect(response.headers.get('set-cookie')).toMatch(
      /better-auth\.session_token=/,
    )
  })

  test('issues a session cookie that resolves through the normal session path', async () => {
    const response = await createAuth().handler(
      new Request('https://example.com/api/auth/dev/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ persona: 'team-owner' }),
      }),
    )

    const user = await getSessionUser(
      new Request('https://example.com/settings', {
        headers: { cookie: cookieHeaderFromSetCookie(response.headers) },
      }),
    )

    expect(user).toMatchObject({
      email: DEV_SIGN_IN_ADMIN_EMAIL,
      emailVerified: true,
      hd: null,
      msTenantId: null,
    })
  })

  test('rejects invalid roles', async () => {
    const response = await createAuth().handler(
      new Request('https://example.com/api/auth/dev/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'owner' }),
      }),
    )

    expect(response.status).toBe(400)
  })

  test('rejects an unknown screen scenario', async () => {
    const response = await createAuth().handler(
      new Request('https://example.com/api/auth/dev/sign-in', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          persona: 'team-owner',
          scenario: 'unknown/scenario',
        }),
      }),
    )

    expect(response.status).toBe(400)
  })
})

function cookieHeaderFromSetCookie(headers: Headers): string {
  const values = headers.getSetCookie?.() ?? [headers.get('set-cookie') ?? '']
  return values
    .filter(Boolean)
    .map((value) => value.split(';')[0])
    .join('; ')
}
