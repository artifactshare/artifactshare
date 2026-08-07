import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { createD1BatchDbMock } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'
import type { Kysely } from 'kysely'
import {
  ensureDomainClaimWorkspace,
  ensureWorkspaceDomainClaim,
  findWorkspaceIdByDomainClaim,
  listWorkspaceMigrationCandidates,
  maybeMoveUserToClaimedWorkspace,
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
    fixture = createMigratedInMemoryDb()
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

  test('creates Microsoft verified domain claim without storing tenant id on workspace', async () => {
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
      ms_tenant_id: null,
      email_domain: 'example.com',
    })
    expect(claim).toEqual({
      domain: 'example.com',
      workspace_id: workspaceId,
      source: 'microsoft_verified_domain',
      provider_tenant_id: 'tenant-1',
    })
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

    await maybeMoveUserToClaimedWorkspace(db, {
      userId: 'u1',
      email: 'alice@corp.com',
      currentWorkspaceId: 'ws-personal',
    })

    await expect(
      db
        .selectFrom('slack_workspaces')
        .select('workspace_id')
        .where('id', '=', 'slack-1')
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
}
