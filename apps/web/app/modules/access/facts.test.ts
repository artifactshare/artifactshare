import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { viewerAccessAllowed } from '~/services/access.server'
import { facts } from './facts'

const NOW = '2026-09-15T00:00:00.000Z'

describe('access facts', () => {
  let db: Kysely<DB>

  beforeEach(async () => {
    db = createMigratedInMemoryDb().db
    await db
      .insertInto('workspaces')
      .values([
        {
          id: 'artifact-workspace',
          hd: 'example.com',
          name: 'Artifact workspace',
          created_at: NOW,
          plan: 'team',
          link_sharing_enabled: 1,
        },
        {
          id: 'viewer-workspace',
          hd: null,
          name: 'Viewer workspace',
          created_at: NOW,
          plan: 'free',
          link_sharing_enabled: 1,
        },
      ])
      .execute()
    await db
      .insertInto('users')
      .values([
        {
          id: 'owner-1',
          email: 'owner@example.com',
          email_verified: 1,
          name: 'Owner',
          image: null,
          created_at: NOW,
          updated_at: NOW,
          workspace_id: 'artifact-workspace',
          locale: null,
        },
        {
          id: 'viewer-1',
          email: 'Viewer@Example.com',
          email_verified: 1,
          name: 'Viewer',
          image: null,
          created_at: NOW,
          updated_at: NOW,
          workspace_id: 'viewer-workspace',
          locale: null,
        },
      ])
      .execute()
    await db
      .insertInto('artifact_containers')
      .values({
        id: 'project-1',
        workspace_id: 'artifact-workspace',
        kind: 'project',
        owner_user_id: null,
        created_by_id: 'viewer-1',
        name: 'Project',
        description: null,
        base_visibility: 'private',
        archived_at: null,
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()
    await db
      .insertInto('shareables')
      .values({
        id: 'share-1',
        workspace_id: 'artifact-workspace',
        owner_user_id: 'owner-1',
        slug: null,
        name: 'artifact.html',
        derived_title: null,
        title_override: null,
        description: null,
        artifact_kind: 'html_page',
        visibility: 'private',
        current_version_id: null,
        container_id: 'project-1',
        created_at: NOW,
        updated_at: NOW,
        last_accessed_at: null,
      })
      .execute()
  })

  afterEach(async () => {
    await db.destroy()
  })

  test('returns null when the shareable does not exist', async () => {
    await expect(
      facts(db, {
        shareableId: 'missing',
        viewerUserId: 'viewer-1',
        now: NOW,
      }),
    ).resolves.toBeNull()
  })

  test('derives viewer identity and project facts from database rows', async () => {
    await db
      .insertInto('shareable_grants')
      .values({
        shareable_id: 'share-1',
        granted_email: 'viewer@example.com',
        granted_at: NOW,
        granted_by: 'owner-1',
      })
      .execute()
    await db
      .insertInto('project_share_defaults')
      .values({
        id: 'project-grant-1',
        project_container_id: 'project-1',
        email: 'VIEWER@example.com',
        display_name: null,
        created_by_id: 'owner-1',
        created_at: NOW,
        updated_at: NOW,
      })
      .execute()

    const result = await facts(db, {
      shareableId: 'share-1',
      viewerUserId: 'viewer-1',
      now: NOW,
    })

    expect(result).toMatchObject({
      visibility: 'private',
      viewerUserId: 'viewer-1',
      viewerWorkspaceId: 'viewer-workspace',
      viewerEmailVerified: true,
      ownerUserId: 'owner-1',
      artifactWorkspaceId: 'artifact-workspace',
      hasShareableGrant: true,
      containerKind: 'project',
      containerBaseVisibility: 'private',
      isProjectCreator: true,
      hasProjectGrant: true,
    })
    expect(result && viewerAccessAllowed(result)).toBe(true)
  })

  test('does not trust a missing viewer id', async () => {
    const result = await facts(db, {
      shareableId: 'share-1',
      viewerUserId: 'missing-viewer',
      now: NOW,
    })

    expect(result).toMatchObject({
      viewerUserId: null,
      viewerWorkspaceId: null,
      viewerEmailVerified: false,
      hasShareableGrant: false,
      isProjectCreator: false,
      isProjectAdmin: false,
      hasProjectGrant: false,
    })
    expect(result && viewerAccessAllowed(result)).toBe(false)
  })

  test('loads active anonymous link access using the supplied clock', async () => {
    await db
      .updateTable('shareables')
      .set({
        visibility: 'link',
        link_expires_at: '2026-09-15T00:00:00.001Z',
      })
      .where('id', '=', 'share-1')
      .execute()

    const active = await facts(db, {
      shareableId: 'share-1',
      viewerUserId: null,
      now: NOW,
    })
    const expired = await facts(db, {
      shareableId: 'share-1',
      viewerUserId: null,
      now: '2026-09-15T00:00:00.001Z',
    })

    expect(active).toMatchObject({
      viewerUserId: null,
      anonymousLinkAllowed: true,
      linkSuspended: false,
    })
    expect(expired).toMatchObject({ anonymousLinkAllowed: false })
  })

  test.each([
    ['invalid expiry', { link_expires_at: '2026-09-15 01:00:00' }],
    ['suspension', { link_suspended_at: NOW }],
  ])('denies anonymous link access for %s', async (_label, patch) => {
    await db
      .updateTable('shareables')
      .set({ visibility: 'link', ...patch })
      .where('id', '=', 'share-1')
      .execute()

    const result = await facts(db, {
      shareableId: 'share-1',
      viewerUserId: null,
      now: NOW,
    })

    expect(result?.anonymousLinkAllowed).toBe(false)
    expect(result?.linkSuspended).toBe('link_suspended_at' in patch)
  })

  test('does not expose suspension when workspace link sharing is disabled', async () => {
    await db
      .updateTable('workspaces')
      .set({ link_sharing_enabled: 0 })
      .where('id', '=', 'artifact-workspace')
      .execute()
    await db
      .updateTable('shareables')
      .set({ visibility: 'link', link_suspended_at: NOW })
      .where('id', '=', 'share-1')
      .execute()

    const result = await facts(db, {
      shareableId: 'share-1',
      viewerUserId: null,
      now: NOW,
    })

    expect(result).toMatchObject({
      anonymousLinkAllowed: false,
      linkSuspended: false,
    })
  })

  test.each(['project', 'inbox'] as const)(
    'keeps Team admin facts separate from project creator/admin facts for %s',
    async (kind) => {
      await db
        .updateTable('artifact_containers')
        .set({ kind, owner_user_id: kind === 'inbox' ? 'viewer-1' : null })
        .where('id', '=', 'project-1')
        .execute()
      await db
        .updateTable('users')
        .set({ workspace_id: 'artifact-workspace' })
        .where('id', '=', 'viewer-1')
        .execute()
      await db
        .insertInto('workspace_members')
        .values({
          workspace_id: 'artifact-workspace',
          user_id: 'viewer-1',
          role: 'admin',
          status: 'active',
          first_contributed_at: null,
          last_contributed_at: null,
          removed_at: null,
          removed_by: null,
          created_at: NOW,
          updated_at: NOW,
        })
        .execute()

      const result = await facts(db, {
        shareableId: 'share-1',
        viewerUserId: 'viewer-1',
        now: NOW,
      })

      expect(result).toMatchObject({
        containerKind: kind,
        isTeamAdmin: true,
        isProjectCreator: kind === 'project',
        isProjectAdmin: kind === 'project',
      })
    },
  )
})
