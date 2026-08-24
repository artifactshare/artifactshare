import { afterEach, describe, expect, test, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import type { Kysely } from 'kysely'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import { createD1BatchDbMock, createD1BatchFixture } from '~/test/d1-batch-mock'
import type { DB } from '~/types/db'
import {
  applyOAuthWorkspaceIntegration,
  planOAuthWorkspaceIntegration,
} from './oauth-workspace-integration.server'

const sqliteRef = vi.hoisted(() => ({
  current: null as DatabaseSync | null,
}))

vi.mock('cloudflare:workers', () => ({
  env: {
    DB: createD1BatchDbMock({ sqlite: sqliteRef }),
  },
}))

describe('OAuth workspace integration', () => {
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

  test('plans and applies an empty personal workspace without changing visibility', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-personal',
        user_id: 'u1',
        role: 'owner',
        status: 'active',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'CORP.COM',
      email: 'Alice@Corp.com',
      source: 'google_hd',
    })

    expect(plan.executable).toBe(true)
    expect(plan.shareables).toEqual([])
    expect(plan.cliRefreshCredentialCount).toBe(0)

    const result = await applyOAuthWorkspaceIntegration(db, plan)
    expect(result.kind).toBe('applied')
    await expectUserWorkspace(db, 'u1', 'ws-org')
    await expect(
      db
        .selectFrom('workspace_members')
        .select(['role', 'status'])
        .where('workspace_id', '=', 'ws-org')
        .where('user_id', '=', 'u1')
        .executeTakeFirst(),
    ).resolves.toEqual({ role: 'member', status: 'active' })
    await expect(
      db
        .selectFrom('workspace_members')
        .select('status')
        .where('workspace_id', '=', 'ws-personal')
        .where('user_id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: 'removed' })
  })

  test('plans a missing Google hd claim without writing, then creates it on apply', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedUser(db, 'u1', 'alice@new-corp.com', 'ws-personal')

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'new-corp.com',
      email: 'alice@new-corp.com',
      source: 'google_hd',
    })
    expect(plan.claim.willCreate).toBe(true)
    expect(plan.targetWorkspace?.willCreate).toBe(true)
    expect(await countWorkspaces(db)).toBe(1)
    expect(await countClaims(db)).toBe(0)

    const result = await applyOAuthWorkspaceIntegration(db, plan)
    expect(result.kind).toBe('applied')
    expect(await countWorkspaces(db)).toBe(2)
    expect(await countClaims(db)).toBe(1)
    await expectUserWorkspace(db, 'u1', plan.targetWorkspace?.id ?? '')
    await expect(
      db
        .selectFrom('workspace_members')
        .select('role')
        .where('workspace_id', '=', plan.targetWorkspace?.id ?? '')
        .where('user_id', '=', 'u1')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ role: 'owner' })
  })

  test('blocks a project name collision before moving any workspace data', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('artifact_containers')
      .values([
        {
          id: 'project-source',
          workspace_id: 'ws-personal',
          kind: 'project',
          owner_user_id: 'u1',
          created_by_id: 'u1',
          name: 'Launch',
          description: null,
          archived_at: null,
          created_at: NOW,
          updated_at: NOW,
        },
        {
          id: 'project-target',
          workspace_id: 'ws-org',
          kind: 'project',
          owner_user_id: null,
          created_by_id: 'u1',
          name: 'launch',
          description: null,
          archived_at: null,
          created_at: NOW,
          updated_at: NOW,
        },
      ])
      .execute()

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })

    expect(plan.executable).toBe(false)
    expect(plan.stopReasons).toContain('target_project_name_conflict')
    const result = await applyOAuthWorkspaceIntegration(db, plan)
    expect(result).toEqual(
      expect.objectContaining({
        kind: 'blocked',
        reasons: expect.arrayContaining(['target_project_name_conflict']),
      }),
    )
    await expectUserWorkspace(db, 'u1', 'ws-personal')
    await expect(
      db
        .selectFrom('artifact_containers')
        .select('workspace_id')
        .where('id', '=', 'project-source')
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
  })

  test('blocks a name collision for a referenced project owned by another user', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedUser(db, 'u2', 'bob@other.example', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('artifact_containers')
      .values([
        {
          id: 'project-source',
          workspace_id: 'ws-personal',
          kind: 'project',
          owner_user_id: 'u2',
          created_by_id: 'u2',
          name: 'Launch',
          description: null,
          archived_at: null,
          created_at: NOW,
          updated_at: NOW,
        },
        {
          id: 'project-target',
          workspace_id: 'ws-org',
          kind: 'project',
          owner_user_id: null,
          created_by_id: 'u1',
          name: 'launch',
          description: null,
          archived_at: null,
          created_at: NOW,
          updated_at: NOW,
        },
      ])
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'share-source',
        workspace_id: 'ws-personal',
        owner_user_id: 'u1',
        slug: null,
        name: 'Shared report',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'markdown_page',
        visibility: 'project',
        current_version_id: null,
        container_id: 'project-source',
        created_at: NOW,
        updated_at: NOW,
        last_accessed_at: null,
      })
      .execute()

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })

    expect(plan.executable).toBe(false)
    expect(plan.stopReasons).toContain('target_project_name_conflict')
    expect(plan.projects).toEqual([
      expect.objectContaining({ id: 'project-source', name: 'Launch' }),
    ])
  })

  test('blocks apply when a project archive state changes during the batch', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'project-source',
        workspace_id: 'ws-personal',
        kind: 'project',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: 'Launch',
        description: null,
        archived_at: null,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })

    await expect(
      applyOAuthWorkspaceIntegration(
        db,
        plan,
        { confirmProjects: plan.requiredConfirmations.projects },
        {
          batch: async (...queries) => {
            await db
              .updateTable('artifact_containers')
              .set({ archived_at: '2026-08-25T00:00:00.000Z' })
              .where('id', '=', 'project-source')
              .execute()
            for (const query of queries) await query.execute()
          },
        },
      ),
    ).rejects.toThrow('NOT NULL constraint failed: audit_events.action')
    await expectUserWorkspace(db, 'u1', 'ws-personal')
  })

  test('blocks removing the source owner while active members remain', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedUser(db, 'u2', 'bob@corp.com', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('workspace_members')
      .values([
        {
          workspace_id: 'ws-personal',
          user_id: 'u1',
          role: 'owner',
          status: 'active',
          created_at: NOW,
          updated_at: NOW,
        },
        {
          workspace_id: 'ws-personal',
          user_id: 'u2',
          role: 'member',
          status: 'active',
          created_at: NOW,
          updated_at: NOW,
        },
      ])
      .execute()

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })

    expect(plan.executable).toBe(false)
    expect(plan.stopReasons).toContain('source_workspace_would_be_ownerless')
  })

  test('requires a per-shareable confirmation and preserves workspace visibility', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedUser(db, 'u2', 'bob@personal.test', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'container-1',
        workspace_id: 'ws-personal',
        kind: 'inbox',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: 'Alice inbox',
        description: null,
        archived_at: null,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'share-1',
        workspace_id: 'ws-personal',
        owner_user_id: 'u1',
        slug: null,
        name: 'notes',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'markdown_page',
        visibility: 'workspace',
        current_version_id: null,
        container_id: 'container-1',
        created_at: NOW,
        updated_at: NOW,
        last_accessed_at: null,
      })
      .execute()

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })
    expect(plan.executable).toBe(true)
    expect(plan.requiredConfirmations.shareables).toEqual([
      {
        id: 'share-1',
        before: { workspaceId: 'ws-personal', visibility: 'workspace' },
        after: { workspaceId: 'ws-org', visibility: 'workspace' },
      },
    ])

    const blocked = await applyOAuthWorkspaceIntegration(db, plan)
    expect(blocked.kind).toBe('blocked')
    await expectShareable(db, 'share-1', 'ws-personal', 'workspace')

    await expect(
      applyOAuthWorkspaceIntegration(
        db,
        plan,
        {
          confirmShareables: [
            {
              id: 'share-1',
              before: 'ws-personal:workspace',
              after: 'ws-org:workspace',
            },
          ],
        },
        {
          batch: async (...queries) => {
            await db
              .insertInto('shareables')
              .values({
                id: 'share-late',
                workspace_id: 'ws-personal',
                owner_user_id: 'u2',
                slug: null,
                name: 'late notes',
                derived_title: null,
                title_override: null,
                description: null,
                artifact_kind: 'markdown_page',
                visibility: 'private',
                current_version_id: null,
                container_id: 'container-1',
                created_at: NOW,
                updated_at: NOW,
                last_accessed_at: null,
              })
              .execute()
            for (const query of queries) await query.execute()
          },
        },
      ),
    ).rejects.toThrow('NOT NULL constraint failed: audit_events.action')
    await expectShareable(db, 'share-1', 'ws-personal', 'workspace')
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirst(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
    await db.deleteFrom('shareables').where('id', '=', 'share-late').execute()

    await expect(
      applyOAuthWorkspaceIntegration(
        db,
        plan,
        {
          confirmShareables: [
            {
              id: 'share-1',
              before: 'ws-personal:workspace',
              after: 'ws-org:workspace',
            },
          ],
        },
        {
          batch: async (...queries) => {
            await db
              .updateTable('shareables')
              .set({ visibility: 'private' })
              .where('id', '=', 'share-1')
              .execute()
            for (const query of queries) await query.execute()
          },
        },
      ),
    ).rejects.toThrow('NOT NULL constraint failed: audit_events.action')
    await expectShareable(db, 'share-1', 'ws-personal', 'private')
    await db
      .updateTable('shareables')
      .set({ visibility: 'workspace' })
      .where('id', '=', 'share-1')
      .execute()

    const applied = await applyOAuthWorkspaceIntegration(db, plan, {
      confirmShareables: [
        {
          id: 'share-1',
          before: 'ws-personal:workspace',
          after: 'ws-org:workspace',
        },
      ],
    })
    expect(applied.kind).toBe('applied')
    await expectShareable(db, 'share-1', 'ws-org', 'workspace')
    await expect(
      db
        .selectFrom('artifact_containers')
        .select('workspace_id')
        .where('id', '=', 'container-1')
        .executeTakeFirst(),
    ).resolves.toEqual({ workspace_id: 'ws-org' })
  })

  test('moves artifacts and containers while preserving grants, versions, R2 keys, owners, and credentials', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'container-1',
        workspace_id: 'ws-personal',
        kind: 'inbox',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: 'Alice inbox',
        description: null,
        archived_at: null,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'share-1',
        workspace_id: 'ws-personal',
        owner_user_id: 'u1',
        slug: null,
        name: 'notes',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'markdown_page',
        visibility: 'private',
        current_version_id: 'version-1',
        container_id: 'container-1',
        created_at: NOW,
        updated_at: NOW,
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'version-1',
        shareable_id: 'share-1',
        artifact_kind: 'markdown_page',
        status: 'published',
        entrypoint_path: 'index.md',
        r2_key: 'artifacts/share-1/version-1',
        size_bytes: 12,
        sha256: 'sha256-1',
        created_by_id: 'u1',
        created_at: NOW,
        published_at: NOW,
      })
      .execute()
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 12 })
      .where('id', '=', 'ws-personal')
      .execute()
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'share-1',
        granted_email: 'viewer@example.com',
        granted_at: NOW,
        granted_by: 'u1',
      })
      .execute()
    await db
      .insertInto('artifact_keys')
      .values({
        id: 'key-1',
        workspace_id: 'ws-personal',
        owner_user_id: 'u1',
        container_id: 'container-1',
        stable_key: 'notes',
        shareable_id: 'share-1',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()
    await db
      .insertInto('cli_refresh_credentials')
      .values({
        id: 'credential-1',
        user_id: 'u1',
        token_hash: 'secret-hash',
        expires_at: '2030-01-01T00:00:00.000Z',
        revoked_at: null,
        created_at: NOW,
        last_used_at: null,
      })
      .execute()

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })
    const before = await db
      .selectFrom('shareables')
      .innerJoin('versions', 'versions.id', 'shareables.current_version_id')
      .innerJoin(
        'shareable_grants',
        'shareable_grants.shareable_id',
        'shareables.id',
      )
      .innerJoin('artifact_keys', 'artifact_keys.shareable_id', 'shareables.id')
      .innerJoin(
        'cli_refresh_credentials',
        'cli_refresh_credentials.user_id',
        'shareables.owner_user_id',
      )
      .select([
        'shareables.owner_user_id',
        'shareables.visibility',
        'shareable_grants.granted_email',
        'versions.id as version_id',
        'versions.r2_key',
        'artifact_keys.owner_user_id as key_owner_user_id',
        'cli_refresh_credentials.user_id as credential_user_id',
      ])
      .where('shareables.id', '=', 'share-1')
      .executeTakeFirstOrThrow()

    const result = await applyOAuthWorkspaceIntegration(
      db,
      plan,
      {
        confirmShareables: [
          {
            id: 'share-1',
            before: 'ws-personal:private',
            after: 'ws-org:private',
          },
        ],
        preserveCliRefreshCredentials: true,
      },
      {
        batch: async (...queries) => {
          for (const query of queries) await query.execute()
        },
      },
    )
    expect(result.kind).toBe('applied')

    const after = await db
      .selectFrom('shareables')
      .innerJoin('versions', 'versions.id', 'shareables.current_version_id')
      .innerJoin(
        'shareable_grants',
        'shareable_grants.shareable_id',
        'shareables.id',
      )
      .innerJoin('artifact_keys', 'artifact_keys.shareable_id', 'shareables.id')
      .innerJoin(
        'cli_refresh_credentials',
        'cli_refresh_credentials.user_id',
        'shareables.owner_user_id',
      )
      .select([
        'shareables.owner_user_id',
        'shareables.visibility',
        'shareable_grants.granted_email',
        'versions.id as version_id',
        'versions.r2_key',
        'artifact_keys.owner_user_id as key_owner_user_id',
        'cli_refresh_credentials.user_id as credential_user_id',
      ])
      .where('shareables.id', '=', 'share-1')
      .executeTakeFirstOrThrow()
    expect(after).toEqual(before)
    await expectShareable(db, 'share-1', 'ws-org', 'private')
    await expect(
      db
        .selectFrom('artifact_keys')
        .select('workspace_id')
        .where('id', '=', 'key-1')
        .executeTakeFirst(),
    ).resolves.toEqual({ workspace_id: 'ws-org' })
    await expect(
      db
        .selectFrom('workspaces')
        .select(['id', 'storage_used_bytes'])
        .where('id', '=', 'ws-personal')
        .executeTakeFirst(),
    ).resolves.toEqual({ id: 'ws-personal', storage_used_bytes: 0 })
    await expect(
      db
        .selectFrom('workspaces')
        .select('storage_used_bytes')
        .where('id', '=', 'ws-org')
        .executeTakeFirst(),
    ).resolves.toEqual({ storage_used_bytes: 12 })
  })

  test('stops when a selected container contains another owner or workspace shareable', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-other', name: 'other.example' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedUser(db, 'u2', 'bob@other.example', 'ws-other')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'container-1',
        workspace_id: 'ws-personal',
        kind: 'inbox',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: 'Alice inbox',
        description: null,
        archived_at: null,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()
    for (const [id, owner, workspace] of [
      ['share-1', 'u1', 'ws-personal'],
      ['share-2', 'u2', 'ws-other'],
    ] as const) {
      await db
        .insertInto('shareables')
        .values({
          id,
          workspace_id: workspace,
          owner_user_id: owner,
          slug: null,
          name: id,
          derived_title: null,
          title_override: null,
          description: null,
          artifact_kind: 'markdown_page',
          visibility: 'workspace',
          current_version_id: null,
          container_id: 'container-1',
          created_at: NOW,
          updated_at: NOW,
          last_accessed_at: null,
        })
        .execute()
    }

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })
    expect(plan.executable).toBe(false)
    expect(plan.stopReasons).toContain('container_shareable_mismatch')

    const result = await applyOAuthWorkspaceIntegration(db, plan, {
      confirmShareables: [
        {
          id: 'share-1',
          before: 'ws-personal:workspace',
          after: 'ws-org:workspace',
        },
      ],
    })
    expect(result.kind).toBe('blocked')
    await expectUserWorkspace(db, 'u1', 'ws-personal')
    await expectShareable(db, 'share-1', 'ws-personal', 'workspace')
    await expectShareable(db, 'share-2', 'ws-other', 'workspace')
    await expect(
      db
        .selectFrom('artifact_containers')
        .select('workspace_id')
        .where('id', '=', 'container-1')
        .executeTakeFirst(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
  })

  test('requires credential preservation confirmation and does not expose its hash', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('cli_refresh_credentials')
      .values({
        id: 'credential-1',
        user_id: 'u1',
        token_hash: 'secret-hash',
        expires_at: '2030-01-01T00:00:00.000Z',
        revoked_at: null,
        created_at: NOW,
        last_used_at: null,
      })
      .execute()

    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })
    expect(plan.cliRefreshCredentialCount).toBe(1)
    expect(JSON.stringify(plan)).not.toContain('secret-hash')
    const blocked = await applyOAuthWorkspaceIntegration(db, plan)
    expect(blocked.kind).toBe('blocked')
    expect(await countAudits(db)).toBe(0)

    const applied = await applyOAuthWorkspaceIntegration(db, plan, {
      preserveCliRefreshCredentials: true,
    })
    expect(applied.kind).toBe('applied')
    expect(await countCredentials(db)).toBe(1)
    await expectUserWorkspace(db, 'u1', 'ws-org')
  })

  test('rejects public domains and email/domain mismatches without writing', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedUser(db, 'u1', 'alice@gmail.com', 'ws-personal')
    const publicPlan = await planOAuthWorkspaceIntegration(db, {
      domain: 'gmail.com',
      email: 'alice@gmail.com',
      source: 'google_hd',
    })
    expect(publicPlan.executable).toBe(false)
    expect(publicPlan.stopReasons).toContain('public_email_domain')
    expect(await countWorkspaces(db)).toBe(1)

    const mismatchPlan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@gmail.com',
      source: 'google_hd',
    })
    expect(mismatchPlan.executable).toBe(false)
    expect(mismatchPlan.stopReasons).toContain('google_hd_not_verified')
    expect(await countWorkspaces(db)).toBe(1)
  })

  test('is idempotent for the same plan and creates one audit event', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    const plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })
    const first = await applyOAuthWorkspaceIntegration(db, plan)
    const second = await applyOAuthWorkspaceIntegration(db, plan)
    expect(first.kind).toBe('applied')
    expect(second).toEqual({
      kind: 'already-applied',
      planId: plan.planId,
      auditEventId: `oauth-workspace-integration:${plan.planId}`,
    })
    expect(await countAudits(db)).toBe(1)
    expect(await countWorkspaces(db)).toBe(2)
  })

  test('plans and applies a project with its audience and another owner artifact', async () => {
    const db = setup()
    await seedWorkspace(db, { id: 'ws-personal', name: 'Alice' })
    await seedWorkspace(db, { id: 'ws-org', name: 'corp.com' })
    await seedWorkspace(db, { id: 'ws-other', name: 'Other' })
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', 'in', ['ws-personal', 'ws-org'])
      .execute()
    await seedUser(db, 'u1', 'alice@corp.com', 'ws-personal')
    await seedUser(db, 'u2', 'author@other.com', 'ws-other')
    await seedUser(db, 'u-admin', 'admin@corp.com', 'ws-org')
    await seedUser(db, 'u-source-admin', 'admin@personal.test', 'ws-personal')
    await seedUser(db, 'u-source-late', 'late@personal.test', 'ws-personal')
    await seedClaim(db, 'corp.com', 'ws-org')
    await db
      .insertInto('workspace_members')
      .values([
        {
          workspace_id: 'ws-org',
          user_id: 'u-admin',
          role: 'owner',
          status: 'active',
          created_at: NOW,
          updated_at: NOW,
        },
        {
          workspace_id: 'ws-personal',
          user_id: 'u-source-admin',
          role: 'admin',
          status: 'active',
          created_at: NOW,
          updated_at: NOW,
        },
      ])
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'project-1',
        workspace_id: 'ws-personal',
        kind: 'project',
        owner_user_id: 'u1',
        created_by_id: 'u1',
        name: 'Private project',
        description: null,
        archived_at: null,
        base_visibility: 'private',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'member-1',
        project_container_id: 'project-1',
        email: 'viewer@example.com',
        role: 'viewer',
        display_name: 'Viewer',
        created_by_id: 'u1',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'share-project',
        workspace_id: 'ws-personal',
        owner_user_id: 'u2',
        slug: null,
        name: 'Shared report',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'markdown_page',
        visibility: 'project',
        current_version_id: 'version-project',
        container_id: 'project-1',
        created_at: NOW,
        updated_at: NOW,
        last_accessed_at: null,
      })
      .execute()
    await db
      .insertInto('versions')
      .values({
        id: 'version-project',
        shareable_id: 'share-project',
        artifact_kind: 'markdown_page',
        status: 'published',
        entrypoint_path: 'report.md',
        r2_key: 'artifacts/share-project/version-project',
        size_bytes: 25,
        sha256: 'sha-project',
        created_by_id: 'u2',
        created_at: NOW,
        published_at: NOW,
      })
      .execute()
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'share-project',
        granted_email: 'specific@example.com',
        granted_at: NOW,
        granted_by: 'u1',
      })
      .execute()
    await db
      .insertInto('artifact_keys')
      .values({
        id: 'key-project',
        workspace_id: 'ws-personal',
        owner_user_id: 'u2',
        container_id: 'project-1',
        stable_key: 'report',
        shareable_id: 'share-project',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()
    await db
      .updateTable('workspaces')
      .set({ storage_used_bytes: 25 })
      .where('id', '=', 'ws-personal')
      .execute()

    let plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })
    expect(plan.executable).toBe(true)
    expect(plan.stopReasons).not.toContain('project_data_present')
    expect(plan.projects).toEqual([
      expect.objectContaining({
        id: 'project-1',
        baseVisibility: 'private',
        memberDefaults: [
          expect.objectContaining({
            id: 'member-1',
            email: 'viewer@example.com',
            role: 'viewer',
          }),
        ],
        shareableIds: ['share-project'],
        beforeTeamAdminAudience: [
          { userId: 'u-source-admin', email: 'admin@personal.test' },
        ],
        afterTeamAdminAudience: [
          { userId: 'u-admin', email: 'admin@corp.com' },
        ],
      }),
    ])
    expect(plan.shareables[0]).toEqual(
      expect.objectContaining({
        id: 'share-project',
        ownerUserId: 'u2',
        visibility: 'project',
        grants: [
          {
            email: 'specific@example.com',
            grantedAt: NOW,
            grantedBy: 'u1',
          },
        ],
      }),
    )
    expect(plan.artifactKeys).toEqual([
      expect.objectContaining({ id: 'key-project', ownerUserId: 'u2' }),
    ])

    const missingProject = await applyOAuthWorkspaceIntegration(db, plan, {
      confirmShareables: [
        {
          id: 'share-project',
          before: 'ws-personal:project',
          after: 'ws-org:project',
        },
      ],
    })
    expect(missingProject).toEqual(
      expect.objectContaining({
        kind: 'blocked',
        reasons: expect.arrayContaining([
          'missing_project_confirmation:project-1',
        ]),
      }),
    )

    await db
      .updateTable('project_share_defaults')
      .set({ role: 'contributor' })
      .where('id', '=', 'member-1')
      .execute()
    const changed = await applyOAuthWorkspaceIntegration(db, plan, {
      confirmShareables: [
        {
          id: 'share-project',
          before: 'ws-personal:project',
          after: 'ws-org:project',
        },
      ],
      confirmProjects: plan.requiredConfirmations.projects,
    })
    expect(changed).toEqual(
      expect.objectContaining({
        kind: 'blocked',
        reasons: expect.arrayContaining(['plan_changed']),
      }),
    )
    await db
      .updateTable('project_share_defaults')
      .set({ role: 'viewer' })
      .where('id', '=', 'member-1')
      .execute()
    plan = await planOAuthWorkspaceIntegration(db, {
      domain: 'corp.com',
      email: 'alice@corp.com',
      source: 'google_hd',
    })

    await expect(
      applyOAuthWorkspaceIntegration(
        db,
        plan,
        {
          confirmShareables: [
            {
              id: 'share-project',
              before: 'ws-personal:project',
              after: 'ws-org:project',
            },
          ],
          confirmProjects: plan.requiredConfirmations.projects,
        },
        {
          batch: async (...queries) => {
            await db
              .insertInto('workspace_members')
              .values({
                workspace_id: 'ws-personal',
                user_id: 'u-source-late',
                role: 'admin',
                status: 'active',
                created_at: NOW,
                updated_at: NOW,
              })
              .execute()
            for (const query of queries) await query.execute()
          },
        },
      ),
    ).rejects.toThrow('NOT NULL constraint failed: audit_events.action')
    await expect(
      db
        .selectFrom('users')
        .select('workspace_id')
        .where('id', '=', 'u1')
        .executeTakeFirst(),
    ).resolves.toEqual({ workspace_id: 'ws-personal' })
    await db
      .deleteFrom('workspace_members')
      .where('workspace_id', '=', 'ws-personal')
      .where('user_id', '=', 'u-source-late')
      .execute()

    const applied = await applyOAuthWorkspaceIntegration(db, plan, {
      confirmShareables: [
        {
          id: 'share-project',
          before: 'ws-personal:project',
          after: 'ws-org:project',
        },
      ],
      confirmProjects: plan.requiredConfirmations.projects,
    })
    expect(applied.kind).toBe('applied')
    await expectShareable(db, 'share-project', 'ws-org', 'project')
    await expect(
      db
        .selectFrom('artifact_containers')
        .select(['workspace_id', 'base_visibility'])
        .where('id', '=', 'project-1')
        .executeTakeFirst(),
    ).resolves.toEqual({ workspace_id: 'ws-org', base_visibility: 'private' })
    await expect(
      db
        .selectFrom('artifact_keys')
        .select(['workspace_id', 'owner_user_id'])
        .where('id', '=', 'key-project')
        .executeTakeFirst(),
    ).resolves.toEqual({ workspace_id: 'ws-org', owner_user_id: 'u2' })
    await expect(
      db
        .selectFrom('project_share_defaults')
        .select(['email', 'role'])
        .where('id', '=', 'member-1')
        .executeTakeFirst(),
    ).resolves.toEqual({ email: 'viewer@example.com', role: 'viewer' })
  })
})

const NOW = '2026-07-19T00:00:00.000Z'

async function seedWorkspace(
  db: Kysely<DB>,
  input: { id: string; name: string },
) {
  await db
    .insertInto('workspaces')
    .values({
      id: input.id,
      hd: null,
      ms_tenant_id: null,
      email_domain: input.name === 'corp.com' ? input.name : null,
      name: input.name,
      created_at: NOW,
    })
    .execute()
}

async function seedClaim(db: Kysely<DB>, domain: string, workspaceId: string) {
  await db
    .insertInto('workspace_domain_claims')
    .values({
      domain,
      workspace_id: workspaceId,
      source: 'google_hd',
      provider_tenant_id: null,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute()
}

async function seedUser(
  db: Kysely<DB>,
  id: string,
  email: string,
  workspaceId: string,
) {
  await db
    .insertInto('users')
    .values({
      id,
      email,
      email_verified: 1,
      name: email,
      image: null,
      created_at: NOW,
      updated_at: NOW,
      workspace_id: workspaceId,
      locale: null,
    })
    .execute()
  const domain = email.split('@')[1]
  const payload = Buffer.from(
    JSON.stringify({ email, email_verified: true, hd: domain }),
  ).toString('base64url')
  await db
    .insertInto('accounts')
    .values({
      id: `google-${id}`,
      user_id: id,
      provider_id: 'google',
      account_id: id,
      id_token: `header.${payload}.signature`,
      created_at: NOW,
      updated_at: NOW,
    })
    .execute()
}

async function expectUserWorkspace(
  db: Kysely<DB>,
  userId: string,
  workspaceId: string,
) {
  await expect(
    db
      .selectFrom('users')
      .select('workspace_id')
      .where('id', '=', userId)
      .executeTakeFirst(),
  ).resolves.toEqual({ workspace_id: workspaceId })
}

async function expectShareable(
  db: Kysely<DB>,
  id: string,
  workspaceId: string,
  visibility: 'private' | 'workspace' | 'project' | 'link',
) {
  await expect(
    db
      .selectFrom('shareables')
      .select(['workspace_id', 'visibility'])
      .where('id', '=', id)
      .executeTakeFirst(),
  ).resolves.toEqual({ workspace_id: workspaceId, visibility })
}

async function countAudits(db: Kysely<DB>) {
  const row = await db
    .selectFrom('audit_events')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

async function countCredentials(db: Kysely<DB>) {
  const row = await db
    .selectFrom('cli_refresh_credentials')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

async function countWorkspaces(db: Kysely<DB>) {
  const row = await db
    .selectFrom('workspaces')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}

async function countClaims(db: Kysely<DB>) {
  const row = await db
    .selectFrom('workspace_domain_claims')
    .select(({ fn }) => fn.countAll<number>().as('count'))
    .executeTakeFirst()
  return Number(row?.count ?? 0)
}
