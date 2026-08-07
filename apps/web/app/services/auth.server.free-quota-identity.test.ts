import { describe, expect, test, vi } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-plan.server'
import {
  enableWorkspaceSelfUploadForOAuthAccount,
  ensureWorkspace,
  mapMicrosoftProfileToUser,
  resolveOAuthWorkspaceAfterAccountCreate,
  workspaceCreationPolicyForAuthRoute,
} from './auth.server'

vi.mock('cloudflare:workers', () => ({
  env: {
    BETTER_AUTH_SECRET: 'test-secret',
    BETTER_AUTH_URL: 'https://example.com',
    GOOGLE_CLIENT_ID: 'test-google-client-id',
    GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
    MICROSOFT_CLIENT_ID: 'test-microsoft-client-id',
    MICROSOFT_CLIENT_SECRET: 'test-microsoft-client-secret',
  },
}))

const VIEWER_POLICY = workspaceCreationPolicyForAuthRoute(undefined)
const OAUTH_GOOGLE_POLICY = workspaceCreationPolicyForAuthRoute('oauth-google')
const OAUTH_MICROSOFT_POLICY =
  workspaceCreationPolicyForAuthRoute('oauth-microsoft')

function createGoogleIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'RS256', typ: 'JWT' }),
  ).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString(
    'base64url',
  )
  return `${header}.${body}.sig`
}

describe('workspaceCreationPolicyForAuthRoute', () => {
  test('email OTP without a marker gets viewer provisioning', () => {
    expect(VIEWER_POLICY).toEqual({
      selfUploadEnabled: false,
      storageQuotaBytes: 0,
    })
  })

  test('OAuth markers keep Free self-upload provisioning', () => {
    expect(OAUTH_GOOGLE_POLICY).toEqual({
      selfUploadEnabled: true,
      storageQuotaBytes: PLAN_STORAGE_QUOTA_BYTES.free,
    })
    expect(OAUTH_MICROSOFT_POLICY).toEqual(OAUTH_GOOGLE_POLICY)
  })
})

describe('OAuth account workspace resolution', () => {
  async function seedUser(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    input: {
      userId: string
      email: string
      workspaceId: string
      selfUploadEnabled: number
      membershipRole?: 'owner' | 'member'
    },
  ) {
    await db
      .insertInto('workspaces')
      .values({
        id: input.workspaceId,
        hd: null,
        name: input.workspaceId,
        created_at: '2026-06-26T00:00:00.000Z',
        email_domain: null,
        self_upload_enabled: input.selfUploadEnabled,
        storage_quota_bytes: input.selfUploadEnabled
          ? PLAN_STORAGE_QUOTA_BYTES.free
          : 0,
      })
      .execute()
    await db
      .insertInto('users')
      .values({
        id: input.userId,
        email: input.email,
        email_verified: 1,
        name: 'Test User',
        image: null,
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
        workspace_id: input.workspaceId,
        locale: null,
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: input.workspaceId,
        user_id: input.userId,
        role: input.membershipRole ?? 'member',
        status: 'active',
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()
  }

  async function seedClaim(
    db: ReturnType<typeof createMigratedInMemoryDb>['db'],
    workspaceId: string,
  ) {
    await db
      .insertInto('workspace_domain_claims')
      .values({
        domain: 'corp.com',
        workspace_id: workspaceId,
        source: 'google_hd',
        provider_tenant_id: null,
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()
  }

  test('existing claim wins for Google hd and removes the empty OTP workspace', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await seedUser(db, {
        userId: 'user-google-hd',
        email: 'alice@corp.com',
        workspaceId: 'ws-otp',
        selfUploadEnabled: 0,
      })
      await seedUser(db, {
        userId: 'org-owner',
        email: 'owner@corp.com',
        workspaceId: 'ws-org',
        selfUploadEnabled: 1,
        membershipRole: 'owner',
      })
      await seedClaim(db, 'ws-org')

      await expect(
        resolveOAuthWorkspaceAfterAccountCreate(db, {
          providerId: 'google',
          userId: 'user-google-hd',
          idToken: createGoogleIdToken({
            email: 'alice@corp.com',
            email_verified: true,
            hd: 'corp.com',
          }),
        }),
      ).resolves.toBe('ws-org')

      await expect(
        db
          .selectFrom('users')
          .select('workspace_id')
          .where('id', '=', 'user-google-hd')
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ workspace_id: 'ws-org' })
      await expect(
        db
          .selectFrom('workspace_members')
          .select(['role', 'status'])
          .where('workspace_id', '=', 'ws-org')
          .where('user_id', '=', 'user-google-hd')
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ role: 'member', status: 'active' })
      await expect(
        db
          .selectFrom('workspaces')
          .select('self_upload_enabled')
          .where('id', '=', 'ws-otp')
          .executeTakeFirst(),
      ).resolves.toBeUndefined()
    } finally {
      await db.destroy()
    }
  })

  test('existing claim wins for Google without hd', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await seedUser(db, {
        userId: 'user-google-no-hd',
        email: 'alice@corp.com',
        workspaceId: 'ws-personal',
        selfUploadEnabled: 0,
      })
      await seedUser(db, {
        userId: 'org-owner-no-hd',
        email: 'owner@corp.com',
        workspaceId: 'ws-org-no-hd',
        selfUploadEnabled: 1,
        membershipRole: 'owner',
      })
      await seedClaim(db, 'ws-org-no-hd')

      await expect(
        resolveOAuthWorkspaceAfterAccountCreate(db, {
          providerId: 'google',
          userId: 'user-google-no-hd',
          idToken: createGoogleIdToken({
            email: 'alice@corp.com',
            email_verified: true,
          }),
        }),
      ).resolves.toBe('ws-org-no-hd')
      await expect(
        db.selectFrom('workspace_domain_claims').select('domain').execute(),
      ).resolves.toEqual([{ domain: 'corp.com' }])
    } finally {
      await db.destroy()
    }
  })

  test('OAuth account resolution reactivates a removed row for the current claim workspace', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await seedUser(db, {
        userId: 'user-removed-membership',
        email: 'alice@corp.com',
        workspaceId: 'ws-org-current',
        selfUploadEnabled: 1,
      })
      await seedClaim(db, 'ws-org-current')
      await db
        .updateTable('workspace_members')
        .set({
          status: 'removed',
          removed_at: '2026-06-26T00:00:00.000Z',
        })
        .where('workspace_id', '=', 'ws-org-current')
        .where('user_id', '=', 'user-removed-membership')
        .execute()

      await expect(
        resolveOAuthWorkspaceAfterAccountCreate(db, {
          providerId: 'google',
          userId: 'user-removed-membership',
          idToken: createGoogleIdToken({
            email: 'alice@corp.com',
            email_verified: true,
          }),
        }),
      ).resolves.toBe('ws-org-current')
      await expect(
        db
          .selectFrom('workspace_members')
          .select(['role', 'status', 'removed_at', 'removed_by'])
          .where('workspace_id', '=', 'ws-org-current')
          .where('user_id', '=', 'user-removed-membership')
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        role: 'member',
        status: 'active',
        removed_at: null,
        removed_by: null,
      })
    } finally {
      await db.destroy()
    }
  })

  test('new Google hd creates an organization workspace after account creation', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await seedUser(db, {
        userId: 'user-new-hd',
        email: 'alice@newcorp.com',
        workspaceId: 'ws-oauth-personal',
        selfUploadEnabled: 1,
        membershipRole: 'owner',
      })

      const resolved = await resolveOAuthWorkspaceAfterAccountCreate(db, {
        providerId: 'google',
        userId: 'user-new-hd',
        idToken: createGoogleIdToken({
          email: 'alice@newcorp.com',
          email_verified: true,
          hd: 'newcorp.com',
        }),
      })
      expect(resolved).not.toBe('ws-oauth-personal')

      await expect(
        db
          .selectFrom('workspace_domain_claims')
          .select(['domain', 'workspace_id', 'source'])
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        domain: 'newcorp.com',
        workspace_id: resolved,
        source: 'google_hd',
      })
      await expect(
        db
          .selectFrom('workspace_members')
          .select(['role', 'status'])
          .where('workspace_id', '=', resolved!)
          .where('user_id', '=', 'user-new-hd')
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ role: 'owner', status: 'active' })
    } finally {
      await db.destroy()
    }
  })

  test('email OTP remains in viewer workspace and never creates claim membership', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId: viewerWorkspaceId } = await ensureWorkspace(
        db,
        'viewer@corp.com',
        null,
        null,
        null,
        true,
        VIEWER_POLICY,
      )
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-claimed',
          hd: null,
          name: 'corp.com',
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: 'corp.com',
        })
        .execute()
      await seedClaim(db, 'ws-claimed')
      expect(viewerWorkspaceId).not.toBe('ws-claimed')
      await expect(
        db
          .selectFrom('workspace_members')
          .select('user_id')
          .where('workspace_id', '=', 'ws-claimed')
          .execute(),
      ).resolves.toEqual([])
    } finally {
      await db.destroy()
    }
  })
})

describe('ensureWorkspace provisioning', () => {
  test('creates a viewer workspace for email OTP without an OAuth marker', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId } = await ensureWorkspace(
        db,
        'viewer@gmail.com',
        null,
        null,
        null,
        true,
        VIEWER_POLICY,
      )

      const workspace = await db
        .selectFrom('workspaces')
        .select(['self_upload_enabled', 'storage_quota_bytes'])
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow()

      expect(workspace).toEqual({
        self_upload_enabled: 0,
        storage_quota_bytes: 0,
      })
    } finally {
      await db.destroy()
    }
  })

  test('creates a self-upload workspace for Google personal OAuth', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId } = await ensureWorkspace(
        db,
        'alice@gmail.com',
        null,
        null,
        null,
        true,
        OAUTH_GOOGLE_POLICY,
      )

      const workspace = await db
        .selectFrom('workspaces')
        .select(['self_upload_enabled', 'storage_quota_bytes'])
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow()

      expect(workspace).toEqual({
        self_upload_enabled: 1,
        storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
      })
    } finally {
      await db.destroy()
    }
  })

  test('creates a self-upload workspace for Microsoft OAuth', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId } = await ensureWorkspace(
        db,
        'bob@outlook.com',
        null,
        'tenant-1',
        null,
        true,
        OAUTH_MICROSOFT_POLICY,
      )

      const workspace = await db
        .selectFrom('workspaces')
        .select(['self_upload_enabled', 'storage_quota_bytes', 'ms_tenant_id'])
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow()

      expect(workspace).toEqual({
        self_upload_enabled: 1,
        storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
        ms_tenant_id: 'tenant-1',
      })
    } finally {
      await db.destroy()
    }
  })

  test('does not join an existing domain workspace for email OTP viewer provisioning', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-existing',
          hd: 'corp.com',
          name: 'corp.com',
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: 'corp.com',
          self_upload_enabled: 1,
          storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
        })
        .execute()

      const { workspaceId } = await ensureWorkspace(
        db,
        'alice@corp.com',
        'corp.com',
        null,
        null,
        true,
        VIEWER_POLICY,
      )

      expect(workspaceId).not.toBe('ws-existing')
      const workspaces = await db
        .selectFrom('workspaces')
        .select(['id', 'self_upload_enabled', 'storage_quota_bytes'])
        .orderBy('id')
        .execute()
      expect(workspaces).toContainEqual({
        id: 'ws-existing',
        self_upload_enabled: 1,
        storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
      })
      expect(workspaces).toContainEqual({
        id: workspaceId,
        self_upload_enabled: 0,
        storage_quota_bytes: 0,
      })
    } finally {
      await db.destroy()
    }
  })

  test('joins an existing domain workspace for Google OAuth provisioning', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-existing',
          hd: 'corp.com',
          name: 'corp.com',
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: 'corp.com',
          self_upload_enabled: 1,
          storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
        })
        .execute()

      const { workspaceId } = await ensureWorkspace(
        db,
        'alice@corp.com',
        'corp.com',
        null,
        null,
        true,
        OAUTH_GOOGLE_POLICY,
      )

      expect(workspaceId).toBe('ws-existing')
      const workspaces = await db
        .selectFrom('workspaces')
        .select(['id', 'self_upload_enabled', 'storage_quota_bytes'])
        .execute()
      expect(workspaces).toEqual([
        {
          id: 'ws-existing',
          self_upload_enabled: 1,
          storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
        },
      ])
    } finally {
      await db.destroy()
    }
  })
})

describe('OAuth profile mapping', () => {
  test('does not use unregistered profile fields for workspace policy', () => {
    expect(
      mapMicrosoftProfileToUser({
        sub: 'sub-1',
        tid: 'tenant-1',
        oid: 'object-1',
        email: 'user@example.com',
        preferred_username: 'user@example.com',
      }),
    ).toEqual({
      id: 'tenant-1:object-1',
      name: 'user@example.com',
      email: 'user@example.com',
      emailVerified: false,
      image: undefined,
    })
  })
})

describe('OAuth account re-login boundary', () => {
  test('linking Google or Microsoft enables an email OTP viewer workspace', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId } = await ensureWorkspace(
        db,
        'viewer@gmail.com',
        null,
        null,
        null,
        true,
        VIEWER_POLICY,
      )
      await db
        .insertInto('users')
        .values({
          id: 'user-viewer',
          email: 'viewer@gmail.com',
          email_verified: 1,
          name: 'Viewer',
          image: null,
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
          workspace_id: workspaceId,
          locale: null,
        })
        .execute()

      await enableWorkspaceSelfUploadForOAuthAccount(db, 'user-viewer')

      const workspace = await db
        .selectFrom('workspaces')
        .select(['self_upload_enabled', 'storage_quota_bytes'])
        .where('id', '=', workspaceId)
        .executeTakeFirstOrThrow()
      expect(workspace).toEqual({
        self_upload_enabled: 1,
        storage_quota_bytes: PLAN_STORAGE_QUOTA_BYTES.free,
      })
    } finally {
      await db.destroy()
    }
  })

  test('linking OAuth enables self-upload while preserving an existing nonzero quota', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      await db
        .insertInto('workspaces')
        .values({
          id: 'ws-custom',
          hd: null,
          name: 'custom',
          created_at: '2026-06-26T00:00:00.000Z',
          email_domain: 'custom.example',
          self_upload_enabled: 0,
          storage_quota_bytes: 1234,
        })
        .execute()
      await db
        .insertInto('users')
        .values({
          id: 'user-custom',
          email: 'custom@example.com',
          email_verified: 1,
          name: 'Custom',
          image: null,
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
          workspace_id: 'ws-custom',
          locale: null,
        })
        .execute()

      await enableWorkspaceSelfUploadForOAuthAccount(db, 'user-custom')

      const workspace = await db
        .selectFrom('workspaces')
        .select(['self_upload_enabled', 'storage_quota_bytes'])
        .where('id', '=', 'ws-custom')
        .executeTakeFirstOrThrow()
      expect(workspace).toEqual({
        self_upload_enabled: 1,
        storage_quota_bytes: 1234,
      })
    } finally {
      await db.destroy()
    }
  })

  test('existing provider account resolves to the same user without a new workspace', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId } = await ensureWorkspace(
        db,
        'alice@gmail.com',
        null,
        null,
        null,
        true,
        OAUTH_GOOGLE_POLICY,
      )
      await db
        .insertInto('users')
        .values({
          id: 'user-google',
          email: 'alice@gmail.com',
          email_verified: 1,
          name: 'Alice',
          image: null,
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
          workspace_id: workspaceId,
          locale: null,
        })
        .execute()
      await db
        .insertInto('accounts')
        .values({
          id: 'acct-google',
          user_id: 'user-google',
          provider_id: 'google',
          account_id: 'google-sub-1',
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
        })
        .execute()

      const resolved = await db
        .selectFrom('accounts')
        .innerJoin('users', 'users.id', 'accounts.user_id')
        .select(['users.id as user_id', 'users.workspace_id'])
        .where('accounts.provider_id', '=', 'google')
        .where('accounts.account_id', '=', 'google-sub-1')
        .executeTakeFirstOrThrow()

      expect(resolved).toEqual({
        user_id: 'user-google',
        workspace_id: workspaceId,
      })

      const workspaceCount = await db
        .selectFrom('workspaces')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow()
      expect(workspaceCount.count).toBe(1)
    } finally {
      await db.destroy()
    }
  })

  test('existing Microsoft provider account resolves to the same user without a new workspace', async () => {
    const { db } = createMigratedInMemoryDb()
    try {
      const { workspaceId } = await ensureWorkspace(
        db,
        'bob@outlook.com',
        null,
        'tenant-1',
        null,
        true,
        OAUTH_MICROSOFT_POLICY,
      )
      await db
        .insertInto('users')
        .values({
          id: 'user-microsoft',
          email: 'bob@outlook.com',
          email_verified: 1,
          name: 'Bob',
          image: null,
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
          workspace_id: workspaceId,
          locale: null,
        })
        .execute()
      await db
        .insertInto('accounts')
        .values({
          id: 'acct-microsoft',
          user_id: 'user-microsoft',
          provider_id: 'microsoft',
          account_id: 'tenant-1:object-1',
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
        })
        .execute()

      const resolved = await db
        .selectFrom('accounts')
        .innerJoin('users', 'users.id', 'accounts.user_id')
        .select(['users.id as user_id', 'users.workspace_id'])
        .where('accounts.provider_id', '=', 'microsoft')
        .where('accounts.account_id', '=', 'tenant-1:object-1')
        .executeTakeFirstOrThrow()

      expect(resolved).toEqual({
        user_id: 'user-microsoft',
        workspace_id: workspaceId,
      })

      const workspaceCount = await db
        .selectFrom('workspaces')
        .select((eb) => eb.fn.countAll<number>().as('count'))
        .executeTakeFirstOrThrow()
      expect(workspaceCount.count).toBe(1)
    } finally {
      await db.destroy()
    }
  })
})
