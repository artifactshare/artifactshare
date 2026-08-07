import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import {
  isTeamWorkspaceAdmin,
  isWorkspaceAdmin,
  viewerDisplayCheck,
  type ArtifactSnapshot,
} from './access.server'

const META: ArtifactSnapshot = {
  id: 'share1',
  modifiedTime: '2026-05-22T00:00:00.000Z',
  name: 'index.html',
  mimeType: 'text/html',
  ownerEmail: 'owner@example.com',
}

const baseContext = {
  shareableId: 'share1',
  ownerUserId: 'owner-1',
  artifactWorkspaceId: 'ws-a',
  viewerWorkspaceId: 'ws-b',
  viewerEmail: 'viewer@example.com',
  viewerEmailVerified: true,
  containerId: 'owner-inbox',
  containerKind: 'inbox',
  containerBaseVisibility: 'workspace',
} as const

async function seedWorkspaces(db: Kysely<DB>) {
  await db
    .insertInto('workspaces')
    .values([
      {
        id: 'ws-a',
        hd: 'example.com',
        name: 'Owner workspace',
        created_at: '2026-05-22T00:00:00.000Z',
      },
      {
        id: 'ws-b',
        hd: null,
        name: 'Viewer workspace',
        created_at: '2026-05-22T00:00:00.000Z',
      },
    ])
    .execute()
  await db
    .insertInto('users')
    .values({
      id: 'owner-1',
      email: 'owner@example.com',
      email_verified: 1,
      name: 'Owner',
      image: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      workspace_id: 'ws-a',
      locale: null,
    })
    .execute()
  await db
    .insertInto('artifact_containers')
    .values({
      id: 'owner-inbox',
      workspace_id: 'ws-a',
      kind: 'inbox',
      owner_user_id: 'owner-1',
      created_by_id: 'owner-1',
      name: '未整理',
      description: null,
      archived_at: null,
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
    })
    .execute()
  await db
    .insertInto('shareables')
    .values({
      id: 'share1',
      workspace_id: 'ws-a',
      owner_user_id: 'owner-1',
      slug: null,
      name: 'sample.html',
      derived_title: 'Sample',
      title_override: null,
      description: null,
      artifact_kind: 'html_page',
      visibility: 'private',
      current_version_id: null,
      view_count: 0,
      container_id: 'owner-inbox',
      created_at: '2026-05-22T00:00:00.000Z',
      updated_at: '2026-05-22T00:00:00.000Z',
      last_accessed_at: null,
    })
    .execute()
}

describe('viewerDisplayCheck', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    db = createMigratedInMemoryDb().db
    await seedWorkspaces(db)
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('private visibility denies anonymous viewers', async () => {
    const result = await viewerDisplayCheck(
      db,
      'private',
      null,
      META,
      baseContext,
    )

    expect(result).toEqual({ kind: 'access-denied' })
  })

  test('anonymous link visibility uses the paid workspace policy', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', 'ws-a')
      .execute()
    await db
      .updateTable('shareables')
      .set({ visibility: 'link' })
      .where('id', '=', 'share1')
      .execute()

    const result = await viewerDisplayCheck(db, 'link', null, META, {
      ...baseContext,
      viewerWorkspaceId: null,
      viewerEmail: null,
      viewerEmailVerified: false,
      now: '2026-05-22T00:00:00.000Z',
    })

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('Free and disabled Team link policies deny anonymous viewers', async () => {
    await db
      .updateTable('shareables')
      .set({ visibility: 'link' })
      .where('id', '=', 'share1')
      .execute()

    await db
      .updateTable('workspaces')
      .set({ plan: 'free', link_sharing_enabled: 1 })
      .where('id', '=', 'ws-a')
      .execute()
    await expect(
      viewerDisplayCheck(db, 'link', null, META, {
        ...baseContext,
        viewerWorkspaceId: null,
        viewerEmail: null,
        viewerEmailVerified: false,
        now: '2026-05-22T00:00:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'access-denied' })

    await db
      .updateTable('workspaces')
      .set({ plan: 'team', link_sharing_enabled: 0 })
      .where('id', '=', 'ws-a')
      .execute()
    await expect(
      viewerDisplayCheck(db, 'link', null, META, {
        ...baseContext,
        viewerWorkspaceId: null,
        viewerEmail: null,
        viewerEmailVerified: false,
        now: '2026-05-22T00:00:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'access-denied' })
  })

  test('expired links deny anonymous viewers but preserve the owner access', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'plus', link_sharing_enabled: 1 })
      .where('id', '=', 'ws-a')
      .execute()
    await db
      .updateTable('shareables')
      .set({
        visibility: 'link',
        link_expires_at: '2026-05-21T23:59:59.000Z',
      })
      .where('id', '=', 'share1')
      .execute()

    await expect(
      viewerDisplayCheck(db, 'link', null, META, {
        ...baseContext,
        viewerWorkspaceId: null,
        viewerEmail: null,
        viewerEmailVerified: false,
        now: '2026-05-22T00:00:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'access-denied' })
    await expect(
      viewerDisplayCheck(db, 'link', 'owner-1', META, {
        ...baseContext,
        viewerWorkspaceId: 'ws-a',
        viewerEmail: 'owner@example.com',
        now: '2026-05-22T00:00:00.000Z',
      }),
    ).resolves.toEqual({ kind: 'access-granted', meta: META })
  })

  test('private visibility grants the owner', async () => {
    const result = await viewerDisplayCheck(
      db,
      'private',
      'owner-1',
      META,
      baseContext,
    )

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('workspace visibility grants viewers in the same workspace', async () => {
    const result = await viewerDisplayCheck(db, 'workspace', 'viewer-1', META, {
      ...baseContext,
      viewerWorkspaceId: 'ws-a',
    })

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('workspace visibility denies viewers from a different workspace without a grant', async () => {
    const result = await viewerDisplayCheck(
      db,
      'workspace',
      'viewer-1',
      META,
      baseContext,
    )

    expect(result).toEqual({ kind: 'access-denied' })
  })

  test('private visibility grants viewers listed in shareable_grants', async () => {
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'share1',
        granted_email: 'viewer@example.com',
        granted_at: '2026-05-22T00:00:00.000Z',
        granted_by: 'owner-1',
      })
      .execute()

    const result = await viewerDisplayCheck(
      db,
      'private',
      'viewer-1',
      META,
      baseContext,
    )

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('a matching grant is denied when the viewer email is unverified', async () => {
    // Security gate: email-grant access requires a proven email. A viewer whose
    // address is not verified (e.g. an unverified Microsoft tenant claim) must
    // not reach content shared to that address until they prove it (email code).
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'share1',
        granted_email: 'viewer@example.com',
        granted_at: '2026-05-22T00:00:00.000Z',
        granted_by: 'owner-1',
      })
      .execute()

    const result = await viewerDisplayCheck(db, 'private', 'viewer-1', META, {
      ...baseContext,
      viewerEmailVerified: false,
    })

    expect(result).toEqual({ kind: 'access-denied' })
  })

  test('grant lookup is case-insensitive on the viewer email', async () => {
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'share1',
        granted_email: 'viewer@example.com',
        granted_at: '2026-05-22T00:00:00.000Z',
        granted_by: 'owner-1',
      })
      .execute()

    const result = await viewerDisplayCheck(db, 'private', 'viewer-1', META, {
      ...baseContext,
      viewerEmail: 'VIEWER@example.com',
    })

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('grant lookup is case-insensitive on the stored granted_email', async () => {
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'share1',
        granted_email: 'Viewer@Example.com',
        granted_at: '2026-05-22T00:00:00.000Z',
        granted_by: 'owner-1',
      })
      .execute()

    const result = await viewerDisplayCheck(
      db,
      'private',
      'viewer-1',
      META,
      baseContext,
    )

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('private visibility without a grant returns access-denied', async () => {
    const result = await viewerDisplayCheck(
      db,
      'private',
      'viewer-1',
      META,
      baseContext,
    )

    expect(result).toEqual({ kind: 'access-denied' })
  })

  async function seedProjectAudience(
    email: string,
    base: 'workspace' | 'private' = 'workspace',
  ) {
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'project-1',
        workspace_id: 'ws-a',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'owner-1',
        name: 'Client project',
        description: null,
        base_visibility: base,
        archived_at: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'psd-1',
        project_container_id: 'project-1',
        email,
        role: 'viewer',
        display_name: null,
        created_by_id: 'owner-1',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
  }

  const projectContext = {
    ...baseContext,
    containerId: 'project-1',
    containerKind: 'project',
    containerBaseVisibility: 'workspace',
  } as const

  test('project visibility grants viewers in the project audience', async () => {
    await seedProjectAudience('viewer@example.com')

    const result = await viewerDisplayCheck(
      db,
      'project',
      'viewer-1',
      META,
      projectContext,
    )

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('project audience match is case-insensitive on the viewer email', async () => {
    await seedProjectAudience('viewer@example.com')

    const result = await viewerDisplayCheck(db, 'project', 'viewer-1', META, {
      ...projectContext,
      viewerEmail: 'VIEWER@example.com',
    })

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('project audience match is case-insensitive on the stored email', async () => {
    await seedProjectAudience('Viewer@Example.com')

    const result = await viewerDisplayCheck(
      db,
      'project',
      'viewer-1',
      META,
      projectContext,
    )

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('project visibility denies viewers outside the project audience', async () => {
    await seedProjectAudience('someone-else@example.com')

    const result = await viewerDisplayCheck(
      db,
      'project',
      'viewer-1',
      META,
      projectContext,
    )

    expect(result).toEqual({ kind: 'access-denied' })
  })

  test('project visibility denies anonymous viewers', async () => {
    await seedProjectAudience('viewer@example.com')

    const result = await viewerDisplayCheck(
      db,
      'project',
      null,
      META,
      projectContext,
    )

    expect(result).toEqual({ kind: 'access-denied' })
  })

  test('project base=workspace grants same-workspace viewers not in the audience', async () => {
    await seedProjectAudience('someone-else@example.com', 'workspace')

    const result = await viewerDisplayCheck(db, 'project', 'viewer-1', META, {
      ...projectContext,
      viewerWorkspaceId: 'ws-a',
    })

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('project base=private denies same-workspace viewers not in the audience', async () => {
    await seedProjectAudience('someone-else@example.com', 'private')

    const result = await viewerDisplayCheck(db, 'project', 'viewer-1', META, {
      ...projectContext,
      containerBaseVisibility: 'private',
      viewerWorkspaceId: 'ws-a',
    })

    expect(result).toEqual({ kind: 'access-denied' })
  })

  test('project base=private grants the project creator even when not in the audience', async () => {
    // 成果物は社外投稿者が所有し、閲覧者は作成者 (owner-1)。作成者は関係者リストに
    // 載らないが、プロジェクトを管理する立場として project 可視成果物を見られる。
    await seedProjectAudience('someone-else@example.com', 'private')

    const result = await viewerDisplayCheck(db, 'project', 'owner-1', META, {
      ...projectContext,
      ownerUserId: 'external-1',
      containerBaseVisibility: 'private',
      viewerWorkspaceId: 'ws-a',
      viewerEmail: 'owner@example.com',
    })

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('project base=private grants a team workspace admin even when not in the audience', async () => {
    await seedProjectAudience('someone-else@example.com', 'private')
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', 'ws-a')
      .execute()
    await db
      .insertInto('users')
      .values({
        id: 'admin-1',
        email: 'admin@example.com',
        email_verified: 1,
        name: 'Admin',
        image: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        workspace_id: 'ws-a',
        locale: null,
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'admin-1',
        role: 'admin',
        status: 'active',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()

    const result = await viewerDisplayCheck(db, 'project', 'admin-1', META, {
      ...projectContext,
      ownerUserId: 'external-1',
      containerBaseVisibility: 'private',
      viewerWorkspaceId: 'ws-a',
      viewerEmail: 'admin@example.com',
    })

    expect(result).toEqual({ kind: 'access-granted', meta: META })
  })

  test('project visibility uses the container base visibility supplied by the caller', async () => {
    await seedProjectAudience('someone-else@example.com', 'workspace')

    const result = await viewerDisplayCheck(db, 'project', 'viewer-1', META, {
      ...projectContext,
      containerBaseVisibility: 'private',
      viewerWorkspaceId: 'ws-a',
    })

    expect(result).toEqual({ kind: 'access-denied' })
  })

  test('project visibility does not use inbox base visibility', async () => {
    const result = await viewerDisplayCheck(db, 'project', 'viewer-1', META, {
      ...baseContext,
      viewerWorkspaceId: 'ws-a',
    })

    expect(result).toEqual({ kind: 'access-denied' })
  })
})

describe('isWorkspaceAdmin', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    db = createMigratedInMemoryDb().db
    await seedWorkspaces(db)
    await db
      .insertInto('users')
      .values({
        id: 'admin-1',
        email: 'admin@example.com',
        email_verified: 1,
        name: 'Admin',
        image: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        workspace_id: 'ws-a',
        locale: null,
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'admin-1',
        role: 'admin',
        status: 'active',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('grants a recorded admin of the workspace', async () => {
    const result = await isWorkspaceAdmin(
      db,
      { id: 'admin-1', workspaceId: 'ws-a' },
      'ws-a',
    )
    expect(result).toBe(true)
  })

  test('denies a non-admin member of the workspace', async () => {
    const result = await isWorkspaceAdmin(
      db,
      { id: 'owner-1', workspaceId: 'ws-a' },
      'ws-a',
    )
    expect(result).toBe(false)
  })

  test('denies when the user belongs to a different workspace than the target', async () => {
    // admin-1 is a recorded admin of ws-a, but the caller's own workspace is
    // ws-b — admin rights never cross workspaces, so the guard denies it.
    const result = await isWorkspaceAdmin(
      db,
      { id: 'admin-1', workspaceId: 'ws-b' },
      'ws-a',
    )
    expect(result).toBe(false)
  })
})

describe('isTeamWorkspaceAdmin', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    db = createMigratedInMemoryDb().db
    await seedWorkspaces(db)
    await db
      .insertInto('users')
      .values({
        id: 'admin-1',
        email: 'admin@example.com',
        email_verified: 1,
        name: 'Admin',
        image: null,
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
        workspace_id: 'ws-a',
        locale: null,
      })
      .execute()
    await db
      .insertInto('workspace_members')
      .values({
        workspace_id: 'ws-a',
        user_id: 'admin-1',
        role: 'admin',
        status: 'active',
        created_at: '2026-05-22T00:00:00.000Z',
        updated_at: '2026-05-22T00:00:00.000Z',
      })
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('grants a team workspace admin', async () => {
    await db
      .updateTable('workspaces')
      .set({ plan: 'team' })
      .where('id', '=', 'ws-a')
      .execute()

    const result = await isTeamWorkspaceAdmin(
      db,
      { id: 'admin-1', workspaceId: 'ws-a' },
      'ws-a',
    )
    expect(result).toBe(true)
  })

  test('denies a free workspace admin', async () => {
    const result = await isTeamWorkspaceAdmin(
      db,
      { id: 'admin-1', workspaceId: 'ws-a' },
      'ws-a',
    )
    expect(result).toBe(false)
  })

  test('isWorkspaceAdmin stays true for a free workspace admin', async () => {
    const result = await isWorkspaceAdmin(
      db,
      { id: 'admin-1', workspaceId: 'ws-a' },
      'ws-a',
    )
    expect(result).toBe(true)
  })
})
