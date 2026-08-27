import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'
import type { Kysely } from 'kysely'
import {
  ensureDomainClaimWorkspace,
  ensureWorkspaceDomainClaim,
  findWorkspaceIdByDomainClaim,
  findWorkspaceIdForMicrosoftTenantDomain,
  findWorkspaceIdByProviderTenant,
  listWorkspaceMigrationCandidates,
  maybeMoveUserToClaimedWorkspace,
  moveUserToWorkspaceForOAuth,
} from './workspace-domain-claims.server'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
  beforeNextBatch: null as (() => void | Promise<void>) | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1BatchDbMock({ sqlite: sqliteRef }),
  },
}))

describe('workspace domain claims', () => {
  let fixture: ReturnType<typeof createMigratedInMemoryDb> | null = null

  afterEach(async () => {
    await fixture?.db.destroy()
    fixture = null
    sqliteRef.current = null
  })

  function setup() {
    fixture = createD1BatchFixture({ sqlite: sqliteRef })
    sqliteRef.current = fixture.sqlite
    return fixture.db
  }

  test('claim lookup ignores public email domains', async () => {
    const db = setup()
    await seedWorkspace(db, {
      id: 'ws-gmail',
      hd: null,
      emailDomain: 'gmail.com',
    })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'gmail.com',
      workspaceId: 'ws-gmail',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })

    await expect(findWorkspaceIdByDomainClaim(db, 'gmail.com')).resolves.toBe(
      null,
    )
  })

  test('creates one Microsoft tenant workspace with its verified domain claim', async () => {
    const db = setup()

    const workspaceId = await ensureDomainClaimWorkspace(db, {
      domain: 'Example.COM',
      source: 'microsoft_verified_domain',
      providerTenantId: 'tenant-1',
      now: '2026-06-26T00:00:00.000Z',
    })

    const workspace = await db
      .selectFrom('workspaces')
      .select(['id', 'ms_tenant_id', 'email_domain'])
      .where('id', '=', workspaceId)
      .executeTakeFirstOrThrow()
    const claim = await db
      .selectFrom('workspace_domain_claims')
      .select(['domain', 'workspace_id', 'source', 'provider_tenant_id'])
      .where('domain', '=', 'example.com')
      .executeTakeFirstOrThrow()

    expect(workspace).toEqual({
      id: workspaceId,
      ms_tenant_id: 'tenant-1',
      email_domain: 'example.com',
    })
    expect(claim).toEqual({
      domain: 'example.com',
      workspace_id: workspaceId,
      source: 'microsoft_verified_domain',
      provider_tenant_id: 'tenant-1',
    })
  })

  test('attaches a verified domain claim to an existing Microsoft tenant workspace', async () => {
    const db = setup()
    await seedWorkspace(db, {
      id: 'ws-tenant',
      hd: null,
      emailDomain: 'corp.com',
      microsoftTenantId: 'tenant-1',
    })

    await expect(
      ensureDomainClaimWorkspace(db, {
        domain: 'corp.com',
        source: 'microsoft_verified_domain',
        providerTenantId: 'tenant-1',
        now: '2026-06-26T00:00:00.000Z',
      }),
    ).resolves.toBe('ws-tenant')

    await expect(
      db.selectFrom('workspaces').select('id').execute(),
    ).resolves.toEqual([{ id: 'ws-tenant' }])
    await expect(
      db
        .selectFrom('workspace_domain_claims')
        .select(['domain', 'workspace_id', 'provider_tenant_id'])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      domain: 'corp.com',
      workspace_id: 'ws-tenant',
      provider_tenant_id: 'tenant-1',
    })
  })

  test('collapses concurrent verified domains onto one Microsoft tenant workspace', async () => {
    const db = setup()
    const [first, second] = await Promise.all([
      ensureDomainClaimWorkspace(db, {
        domain: 'a.corp.com',
        source: 'microsoft_verified_domain',
        providerTenantId: 'tenant-concurrent',
        now: '2026-06-26T00:00:00.000Z',
      }),
      ensureDomainClaimWorkspace(db, {
        domain: 'b.corp.com',
        source: 'microsoft_verified_domain',
        providerTenantId: 'tenant-concurrent',
        now: '2026-06-26T00:00:00.000Z',
      }),
    ])

    expect(first).toBe(second)
    await expect(
      db.selectFrom('workspaces').select('id').execute(),
    ).resolves.toHaveLength(1)
    await expect(
      db.selectFrom('workspace_domain_claims').select('domain').execute(),
    ).resolves.toHaveLength(2)
  })

  test('does not choose an arbitrary claim workspace by a non-unique provider tenant id', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-a', hd: null, emailDomain: 'a.test' })
    await seedWorkspace(db, { id: 'ws-b', hd: null, emailDomain: 'b.test' })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'a.test',
      workspaceId: 'ws-a',
      source: 'microsoft_verified_domain',
      providerTenantId: 'tenant-legacy',
      now: '2026-06-26T00:00:00.000Z',
    })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'b.test',
      workspaceId: 'ws-b',
      source: 'microsoft_verified_domain',
      providerTenantId: 'tenant-legacy',
      now: '2026-06-26T00:00:00.000Z',
    })

    await expect(
      findWorkspaceIdByProviderTenant(db, 'tenant-legacy'),
    ).resolves.toBeNull()
  })

  test('domain lookup prefers the canonical Microsoft tenant workspace', async () => {
    const db = setup()
    await seedWorkspace(db, {
      id: 'ws-tenant',
      hd: null,
      emailDomain: 'corp.com',
      microsoftTenantId: 'tenant-1',
    })
    await seedWorkspace(db, {
      id: 'ws-duplicate',
      hd: null,
      emailDomain: 'corp.com',
    })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-duplicate',
      source: 'microsoft_verified_domain',
      providerTenantId: 'tenant-1',
      now: '2026-06-26T00:00:00.000Z',
    })
    await db
      .insertInto('workspace_storage_daily_usage')
      .values({
        workspace_id: 'ws-duplicate',
        date: '2026-06-26',
        used_bytes: 0,
        included_bytes: 104857600,
        billable_overage_gb: 0,
      })
      .execute()

    await expect(findWorkspaceIdByDomainClaim(db, 'corp.com')).resolves.toBe(
      'ws-tenant',
    )
  })

  test('domain and tenant lookup preserve a nonempty legacy Microsoft claim workspace', async () => {
    const db = setup()
    await seedWorkspace(db, {
      id: 'ws-tenant',
      hd: null,
      emailDomain: 'corp.com',
      microsoftTenantId: 'tenant-1',
    })
    await seedWorkspace(db, {
      id: 'ws-duplicate',
      hd: null,
      emailDomain: 'corp.com',
    })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-duplicate',
      source: 'microsoft_verified_domain',
      providerTenantId: 'tenant-1',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u-existing',
      email: 'existing@corp.com',
      workspaceId: 'ws-duplicate',
    })

    await expect(findWorkspaceIdByDomainClaim(db, 'corp.com')).resolves.toBe(
      'ws-duplicate',
    )
    await expect(
      findWorkspaceIdForMicrosoftTenantDomain(db, 'tenant-1', 'corp.com'),
    ).resolves.toBe('ws-duplicate')
  })

  test('domain and tenant lookup preserve a Microsoft claim workspace with nonzero usage', async () => {
    const db = setup()
    await seedWorkspace(db, {
      id: 'ws-tenant',
      hd: null,
      emailDomain: 'corp.com',
      microsoftTenantId: 'tenant-1',
    })
    await seedWorkspace(db, {
      id: 'ws-duplicate',
      hd: null,
      emailDomain: 'corp.com',
    })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-duplicate',
      source: 'microsoft_verified_domain',
      providerTenantId: 'tenant-1',
      now: '2026-06-26T00:00:00.000Z',
    })
    await db
      .insertInto('workspace_storage_daily_usage')
      .values({
        workspace_id: 'ws-duplicate',
        date: '2026-06-26',
        used_bytes: 1,
        included_bytes: 104857600,
        billable_overage_gb: 0,
      })
      .execute()

    await expect(findWorkspaceIdByDomainClaim(db, 'corp.com')).resolves.toBe(
      'ws-duplicate',
    )
    await expect(
      findWorkspaceIdForMicrosoftTenantDomain(db, 'tenant-1', 'corp.com'),
    ).resolves.toBe('ws-duplicate')
  })

  test('Microsoft tenant lookup honors a verified domain claim from a different tenant', async () => {
    const db = setup()
    await seedWorkspace(db, {
      id: 'ws-resource-tenant',
      hd: null,
      microsoftTenantId: 'resource-tenant',
    })
    await seedWorkspace(db, {
      id: 'ws-home-domain',
      hd: null,
      emailDomain: 'guest.example',
    })
    await seedWorkspace(db, {
      id: 'ws-home-tenant',
      hd: null,
      emailDomain: 'guest.example',
      microsoftTenantId: 'home-tenant',
    })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'guest.example',
      workspaceId: 'ws-home-domain',
      source: 'microsoft_verified_domain',
      providerTenantId: 'home-tenant',
      now: '2026-06-26T00:00:00.000Z',
    })

    await expect(
      findWorkspaceIdForMicrosoftTenantDomain(
        db,
        'resource-tenant',
        'guest.example',
      ),
    ).resolves.toBe('ws-home-tenant')
  })

  test('moves a verified owner out of an empty viewer workspace', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-viewer', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u-owner',
      email: 'owner@corp.com',
      workspaceId: 'ws-viewer',
    })
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-viewer',
        user_id: 'u-owner',
        role: 'owner',
        status: 'active',
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u-owner',
        email: 'owner@corp.com',
        currentWorkspaceId: 'ws-viewer',
      }),
    ).resolves.toBe('ws-org')
    await expect(
      db
        .selectFrom('workspace_members')
        .select(['role', 'status'])
        .where('workspace_id', '=', 'ws-org')
        .where('user_id', '=', 'u-owner')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ role: 'owner', status: 'active' })
  })

  test('moves a verified owner when the source has only zero-usage history', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-viewer', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u-owner',
      email: 'owner@corp.com',
      workspaceId: 'ws-viewer',
    })
    await db
      .insertInto('workspace_storage_daily_usage')
      .values({
        workspace_id: 'ws-viewer',
        date: '2026-06-26',
        used_bytes: 0,
        included_bytes: 104857600,
        billable_overage_gb: 0,
      })
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u-owner',
        email: 'owner@corp.com',
        currentWorkspaceId: 'ws-viewer',
      }),
    ).resolves.toBe('ws-org')
    await expect(
      db
        .selectFrom('workspace_storage_daily_usage')
        .select('workspace_id')
        .where('workspace_id', '=', 'ws-viewer')
        .executeTakeFirst(),
    ).resolves.toBeUndefined()
  })

  test('reports nonzero source usage as a migration wait reason', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-viewer', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u-owner',
      email: 'owner@corp.com',
      workspaceId: 'ws-viewer',
    })
    await db
      .insertInto('workspace_storage_daily_usage')
      .values({
        workspace_id: 'ws-viewer',
        date: '2026-06-26',
        used_bytes: 1,
        included_bytes: 104857600,
        billable_overage_gb: 0,
      })
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u-owner',
        email: 'owner@corp.com',
        currentWorkspaceId: 'ws-viewer',
      }),
    ).resolves.toBeNull()
    await expect(listWorkspaceMigrationCandidates(db)).resolves.toMatchObject([
      {
        userId: 'u-owner',
        reasonCodes: ['source_workspace_has_usage'],
      },
    ])
  })

  test('reports nullable source expiry policy as configured', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-viewer', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u-owner',
      email: 'owner@corp.com',
      workspaceId: 'ws-viewer',
    })
    await db
      .updateTable('workspaces')
      .set({
        link_expiry_default_days: null,
        link_expiry_max_days: null,
      })
      .where('id', '=', 'ws-viewer')
      .execute()

    await expect(listWorkspaceMigrationCandidates(db)).resolves.toMatchObject([
      {
        userId: 'u-owner',
        reasonCodes: ['source_workspace_configured'],
      },
    ])
  })

  test('promotes an existing target admin before the newly moved member', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-viewer', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u-admin',
      email: 'admin@example.com',
      workspaceId: 'ws-org',
    })
    await seedUser(db, {
      id: 'u-mover',
      email: 'mover@corp.com',
      workspaceId: 'ws-viewer',
    })
    await db
      .insertInto('workspace_members')
      .values([
        {
          workspace_id: 'ws-org',
          user_id: 'u-admin',
          role: 'admin',
          status: 'active',
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
        },
        {
          workspace_id: 'ws-viewer',
          user_id: 'u-mover',
          role: 'owner',
          status: 'active',
          created_at: '2026-06-26T00:00:00.000Z',
          updated_at: '2026-06-26T00:00:00.000Z',
        },
      ])
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u-mover',
        email: 'mover@corp.com',
        currentWorkspaceId: 'ws-viewer',
      }),
    ).resolves.toBe('ws-org')
    await expect(
      db
        .selectFrom('workspace_members')
        .select(['user_id', 'role'])
        .where('workspace_id', '=', 'ws-org')
        .where('status', '=', 'active')
        .orderBy('user_id')
        .execute(),
    ).resolves.toEqual([
      { user_id: 'u-admin', role: 'owner' },
      { user_id: 'u-mover', role: 'member' },
    ])
  })

  test('repairs an ownerless claimed workspace when the user is already there', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u-member',
      email: 'member@corp.com',
      workspaceId: 'ws-org',
    })
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-org',
        user_id: 'u-member',
        role: 'member',
        status: 'active',
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u-member',
        email: 'member@corp.com',
        currentWorkspaceId: 'ws-org',
      }),
    ).resolves.toBeNull()
    await expect(
      db
        .selectFrom('workspace_members')
        .select('role')
        .where('workspace_id', '=', 'ws-org')
        .where('user_id', '=', 'u-member')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ role: 'owner' })
  })

  test('repairs an ownerless OAuth target when the user is already there', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null })
    await seedUser(db, {
      id: 'u-member',
      email: 'member@example.com',
      workspaceId: 'ws-org',
    })
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-org',
        user_id: 'u-member',
        role: 'member',
        status: 'active',
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()

    await expect(
      moveUserToWorkspaceForOAuth(db, {
        userId: 'u-member',
        email: 'member@example.com',
        currentWorkspaceId: 'ws-org',
        targetWorkspaceId: 'ws-org',
      }),
    ).resolves.toBeNull()
    await expect(
      db
        .selectFrom('workspace_members')
        .select('role')
        .where('workspace_id', '=', 'ws-org')
        .where('user_id', '=', 'u-member')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ role: 'owner' })
  })

  test('does not move the owner out of a canonical Microsoft tenant workspace', async () => {
    const db = setup()
    await seedWorkspace(db, {
      id: 'ws-tenant',
      hd: null,
      emailDomain: 'corp.com',
      microsoftTenantId: 'tenant-1',
    })
    await seedWorkspace(db, {
      id: 'ws-claim',
      hd: null,
      emailDomain: 'corp.com',
    })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-claim',
      source: 'microsoft_verified_domain',
      providerTenantId: 'tenant-1',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u-owner',
      email: 'owner@corp.com',
      workspaceId: 'ws-tenant',
    })
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-tenant',
        user_id: 'u-owner',
        role: 'owner',
        status: 'active',
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u-owner',
        email: 'owner@corp.com',
        currentWorkspaceId: 'ws-tenant',
      }),
    ).resolves.toBeNull()
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u-owner')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-tenant' })
  })

  test('does not move a user with a removed membership at the target workspace', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-org',
        user_id: 'u1',
        role: 'member',
        status: 'removed',
        removed_at: '2026-06-26T00:00:00.000Z',
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBe(null)

    const user = await db
      .selectFrom('users')
      .select('workspace_id')
      .where('id', '=', 'u1')
      .executeTakeFirstOrThrow()
    expect(user.workspace_id).toBe('ws-personal')
  })

  test('rolls back when target membership is removed after the preflight check', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    sqliteRef.beforeNextBatch = () => {
      sqliteRef.current
        ?.prepare(
          `INSERT INTO workspace_members
             (workspace_id, user_id, role, status, created_at, updated_at)
           VALUES ('ws-org', 'u1', 'member', 'removed',
                   '2026-06-26T00:00:00.000Z', '2026-06-26T00:00:00.000Z')`,
        )
        .run()
    }

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).rejects.toThrow()

    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
  })

  test('rolls back when agent data appears before the move batch', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-org',
        user_id: 'u1',
        role: 'member',
        status: 'active',
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()
    sqliteRef.beforeNextBatch = () => {
      sqliteRef.current
        ?.prepare(
          `INSERT INTO agent_profiles (id, user_id, workspace_id, created_at)
           VALUES ('agent-race', 'u1', 'ws-personal', '2026-06-26T00:00:00.000Z')`,
        )
        .run()
    }

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).rejects.toThrow()
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
    await expect(
      db
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', 'ws-personal')
        .executeTakeFirst(),
    ).resolves.toEqual({ id: 'ws-personal' })
    await expect(
      db
        .selectFrom('agent_profiles')
        .select(['id', 'workspace_id'])
        .where('id', '=', 'agent-race')
        .executeTakeFirst(),
    ).resolves.toEqual({ id: 'agent-race', workspace_id: 'ws-personal' })
  })

  test('rolls back when an API token appears before the move batch', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    sqliteRef.beforeNextBatch = () => {
      sqliteRef.current
        ?.prepare(
          `INSERT INTO api_tokens (id, user_id, name, token_hash, created_at)
           VALUES ('token-race', 'u1', 'CLI', 'hash-race',
                   '2026-06-26T00:00:00.000Z')`,
        )
        .run()
    }

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).rejects.toThrow()
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
    await expect(
      db
        .selectFrom('api_tokens')
        .select('id')
        .where('id', '=', 'token-race')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ id: 'token-race' })
  })

  test('keeps users with delegated OAuth tokens in their current workspace', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    sqliteRef.current?.exec(`
      INSERT INTO oauthClient (id, clientId, redirectUris)
      VALUES ('client-row', 'client-1', '[]');
      INSERT INTO oauthAccessToken (
        id, token, clientId, userId, scopes
      ) VALUES (
        'access-1', 'delegated-token', 'client-1', 'u1', 'openid'
      );
    `)

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBeNull()
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })

    sqliteRef.current
      ?.prepare(
        `UPDATE oauthAccessToken SET expiresAt = '2020-01-01T00:00:00.000Z'
         WHERE id = 'access-1'`,
      )
      .run()
    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBe('ws-org')
  })

  test('rolls back when a delegated OAuth token appears before the move batch', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    sqliteRef.current?.exec(`
      INSERT INTO oauthClient (id, clientId, redirectUris)
      VALUES ('client-row', 'client-1', '[]');
    `)
    sqliteRef.beforeNextBatch = () => {
      sqliteRef.current?.exec(`
        INSERT INTO oauthAccessToken (
          id, token, clientId, userId, scopes
        ) VALUES (
          'access-race', 'delegated-race', 'client-1', 'u1', 'openid'
        );
      `)
    }

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).rejects.toThrow()
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
  })

  test('rolls back when a shareable appears in the source workspace before the move batch', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'target-inbox',
        workspace_id: 'ws-org',
        kind: 'inbox',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: 'Inbox',
        description: null,
        archived_at: null,
        base_visibility: 'private',
        created_at: '2026-06-26T00:00:00.000Z',
        updated_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()
    sqliteRef.beforeNextBatch = () => {
      sqliteRef.current
        ?.prepare(
          `INSERT INTO shareables (
             id, workspace_id, owner_user_id, name, artifact_kind, visibility,
             created_at, updated_at, container_id
           ) VALUES (
             'share-race', 'ws-personal', 'u1', 'Draft', 'markdown_page',
             'private', '2026-06-26T00:00:00.000Z',
             '2026-06-26T00:00:00.000Z', 'target-inbox'
           )`,
        )
        .run()
    }

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).rejects.toThrow()
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
    await expect(
      db
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', 'ws-personal')
        .executeTakeFirst(),
    ).resolves.toEqual({ id: 'ws-personal' })
    await expect(
      db
        .selectFrom('shareables')
        .select(['id', 'workspace_id'])
        .where('id', '=', 'share-race')
        .executeTakeFirst(),
    ).resolves.toEqual({ id: 'share-race', workspace_id: 'ws-personal' })
  })

  test('keeps a personal workspace with customized sharing settings', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 1 })
      .where('id', '=', 'ws-personal')
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBeNull()
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
  })

  test('keeps a renamed personal workspace', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    await db
      .updateTable('workspaces')
      .set({ name: 'My renamed workspace' })
      .where('id', '=', 'ws-personal')
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBeNull()
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
  })

  test('moves an empty verified personal user into claimed workspace', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBe('ws-org')

    const user = await db
      .selectFrom('users')
      .select('workspace_id')
      .where('id', '=', 'u1')
      .executeTakeFirstOrThrow()
    expect(user.workspace_id).toBe('ws-org')
  })

  test('deletes the empty personal workspace using the live user email', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await seedUser(db, {
      id: 'u1',
      email: 'current@corp.com',
      workspaceId: 'ws-personal',
    })

    await expect(
      moveUserToWorkspaceForOAuth(db, {
        userId: 'u1',
        email: 'stale@corp.com',
        currentWorkspaceId: 'ws-personal',
        targetWorkspaceId: 'ws-org',
      }),
    ).resolves.toBe('ws-org')
    await expect(
      db
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', 'ws-personal')
        .executeTakeFirst(),
    ).resolves.toBeUndefined()
  })

  test('moves a default personal workspace created from a mixed-case email', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    await db
      .updateTable('workspaces')
      .set({ name: "Alice@Corp.com's workspace" })
      .where('id', '=', 'ws-personal')
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBe('ws-org')
    await expect(
      db
        .selectFrom('workspaces')
        .select('id')
        .where('id', '=', 'ws-personal')
        .executeTakeFirst(),
    ).resolves.toBeUndefined()
  })

  test('keeps the source workspace when it has a Slack integration', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    await db
      .insertInto('slack_workspaces')
      .values({
        id: 'slack-1',
        team_id: 'team-1',
        team_name: 'Corp',
        bot_user_id: 'bot-1',
        bot_token: 'test-token',
        installed_by_user_id: 'u1',
        installed_at: '2026-06-26T00:00:00.000Z',
        workspace_id: 'ws-personal',
      })
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBeNull()

    await expect(
      db
        .selectFrom('slack_workspaces')
        .select('workspace_id')
        .where('id', '=', 'slack-1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
  })

  test('keeps users with API tokens in personal workspace and reports migration candidate', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    await db
      .insertInto('api_tokens')
      .values({
        id: 'tok1',
        user_id: 'u1',
        name: 'CLI',
        token_hash: 'hash1',
        created_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBe(null)

    await expect(listWorkspaceMigrationCandidates(db)).resolves.toMatchObject([
      {
        domain: 'corp.com',
        claimWorkspaceId: 'ws-org',
        personalWorkspaceId: 'ws-personal',
        userId: 'u1',
        email: 'alice@corp.com',
        apiTokensCount: 1,
      },
    ])

    await db.deleteFrom('api_tokens').where('id', '=', 'tok1').execute()
    sqliteRef.current?.exec(`
      INSERT INTO oauthClient (id, clientId, redirectUris)
      VALUES ('candidate-client-row', 'candidate-client', '[]');
      INSERT INTO oauthAccessToken (
        id, token, clientId, userId, scopes
      ) VALUES (
        'candidate-access', 'candidate-token', 'candidate-client', 'u1', 'openid'
      );
    `)
    await expect(listWorkspaceMigrationCandidates(db)).resolves.toMatchObject([
      {
        userId: 'u1',
        apiTokensCount: 0,
        oauthAccessTokensCount: 1,
        oauthRefreshTokensCount: 0,
      },
    ])
  })

  test('keeps users with stateless OAuth consent in their current workspace', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-org', hd: null, emailDomain: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-personal', hd: null })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-org',
      source: 'google_hd',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-personal',
    })
    sqliteRef.current?.exec(`
      INSERT INTO oauthClient (id, clientId, redirectUris)
      VALUES ('client-row', 'client-1', '[]');
      INSERT INTO oauthConsent (id, clientId, userId, scopes)
      VALUES ('consent-1', 'client-1', 'u1', 'openid');
    `)

    await expect(
      maybeMoveUserToClaimedWorkspace(db, {
        userId: 'u1',
        email: 'alice@corp.com',
        currentWorkspaceId: 'ws-personal',
      }),
    ).resolves.toBeNull()
    await expect(listWorkspaceMigrationCandidates(db)).resolves.toMatchObject([
      {
        userId: 'u1',
        oauthConsentsCount: 1,
      },
    ])
  })

  test('reports existing Microsoft tenant workspace users as migration candidates', async () => {
    const db = setup()
    await seedWorkspace(db, {
      id: 'ws-claim',
      hd: null,
      emailDomain: 'corp.com',
    })
    await seedWorkspace(db, {
      id: 'ws-ms-tenant',
      hd: null,
      emailDomain: 'corp.com',
      microsoftTenantId: 'tenant-1',
    })
    await ensureWorkspaceDomainClaim(db, {
      domain: 'corp.com',
      workspaceId: 'ws-claim',
      source: 'microsoft_verified_domain',
      providerTenantId: 'tenant-1',
      now: '2026-06-26T00:00:00.000Z',
    })
    await seedUser(db, {
      id: 'u1',
      email: 'alice@corp.com',
      workspaceId: 'ws-ms-tenant',
    })
    await db
      .insertInto('api_tokens')
      .values({
        id: 'tok1',
        user_id: 'u1',
        name: 'CLI',
        token_hash: 'hash1',
        created_at: '2026-06-26T00:00:00.000Z',
      })
      .execute()

    await expect(listWorkspaceMigrationCandidates(db)).resolves.toMatchObject([
      {
        domain: 'corp.com',
        claimWorkspaceId: 'ws-claim',
        personalWorkspaceId: 'ws-ms-tenant',
        userId: 'u1',
        apiTokensCount: 1,
      },
    ])
  })
})

async function seedWorkspace(
  db: Kysely<DB>,
  input: {
    id: string
    hd: string | null
    emailDomain?: string | null
    microsoftTenantId?: string | null
  },
) {
  await db
    .insertInto('workspaces')
    .values({
      id: input.id,
      hd: input.hd,
      ms_tenant_id: input.microsoftTenantId ?? null,
      name: input.hd ?? input.emailDomain ?? input.id,
      created_at: '2026-06-26T00:00:00.000Z',
      email_domain: input.emailDomain ?? input.hd,
    })
    .execute()
}

async function seedUser(
  db: Kysely<DB>,
  input: { id: string; email: string; workspaceId: string },
) {
  await db
    .insertInto('users')
    .values({
      id: input.id,
      email: input.email,
      email_verified: 1,
      name: input.email,
      image: null,
      created_at: '2026-06-26T00:00:00.000Z',
      updated_at: '2026-06-26T00:00:00.000Z',
      workspace_id: input.workspaceId,
    })
    .execute()
  await db
    .updateTable('workspaces')
    .set({ name: `${input.email}'s workspace` })
    .where('id', '=', input.workspaceId)
    .where('name', '=', input.workspaceId)
    .where('hd', 'is', null)
    .where('ms_tenant_id', 'is', null)
    .execute()
}
