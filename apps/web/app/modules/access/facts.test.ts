import { sql, type Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import type { DB } from '~/types/db'
import { viewerAccessAllowed } from '~/services/access.server'
import {
  facts,
  projectAccessAllowed,
  projectAccessAllowedSql,
  projectAccessFactSelections,
  projectAccessFactsFromRow,
  type ProjectAccessFactsRow,
} from './facts'

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

  test('keeps the project SQL predicate equivalent to the pure oracle over the deterministic matrix', async () => {
    await db
      .insertInto('workspaces')
      .values({
        id: 'free-workspace',
        hd: 'free.example',
        name: 'Free workspace',
        created_at: NOW,
        plan: 'free',
      })
      .execute()
    type MatrixCase = {
      name: string
      same: boolean
      base: 'workspace' | 'private'
      creator?: boolean
      role?: 'owner' | 'admin'
      status?: 'active' | 'removed'
      workspace?: string
      grant?: boolean
      verified?: boolean
      archived?: boolean
      missing?: boolean
      kind?: 'project' | 'inbox'
    }
    const cases: MatrixCase[] = [
      { name: 'same workspace visible', same: true, base: 'workspace' },
      { name: 'same workspace private denied', same: true, base: 'private' },
      {
        name: 'same workspace creator',
        same: true,
        base: 'private',
        creator: true,
      },
      { name: 'active team owner', same: true, base: 'private', role: 'owner' },
      { name: 'active team admin', same: true, base: 'private', role: 'admin' },
      {
        name: 'inactive team admin',
        same: true,
        base: 'private',
        role: 'admin',
        status: 'removed',
      },
      {
        name: 'free workspace admin',
        same: true,
        base: 'private',
        role: 'admin',
        workspace: 'free-workspace',
      },
      {
        name: 'verified same-workspace grant',
        same: true,
        base: 'private',
        grant: true,
      },
      {
        name: 'unverified same-workspace grant',
        same: true,
        base: 'private',
        grant: true,
        verified: false,
      },
      {
        name: 'archived same-workspace visible',
        same: true,
        base: 'workspace',
        archived: true,
      },
      {
        name: 'verified cross-workspace grant',
        same: false,
        base: 'private',
        grant: true,
      },
      {
        name: 'unverified cross-workspace grant',
        same: false,
        base: 'private',
        grant: true,
        verified: false,
      },
      { name: 'cross-workspace without grant', same: false, base: 'workspace' },
      {
        name: 'archived cross-workspace grant',
        same: false,
        base: 'private',
        grant: true,
        archived: true,
      },
      { name: 'missing viewer', same: false, base: 'workspace', missing: true },
      {
        name: 'inbox is never a project',
        same: true,
        base: 'workspace',
        kind: 'inbox',
      },
    ]

    for (const [index, entry] of cases.entries()) {
      const suffix = String(index)
      const projectWorkspace = entry.workspace ?? 'artifact-workspace'
      const viewerWorkspace = entry.same ? projectWorkspace : 'viewer-workspace'
      const viewerId = `matrix-viewer-${suffix}`
      const projectId = `matrix-project-${suffix}`
      const viewerEmail = `matrix-${suffix}@example.com`
      if (!entry.missing) {
        await db
          .insertInto('users')
          .values({
            id: viewerId,
            email: viewerEmail,
            email_verified: entry.verified === false ? 0 : 1,
            name: entry.name,
            image: null,
            created_at: NOW,
            updated_at: NOW,
            workspace_id: viewerWorkspace,
            locale: null,
          })
          .execute()
      }
      await db
        .insertInto('artifact_containers')
        .values({
          id: projectId,
          workspace_id: projectWorkspace,
          kind: entry.kind ?? 'project',
          owner_user_id: entry.kind === 'inbox' ? 'owner-1' : null,
          created_by_id: entry.creator ? viewerId : 'owner-1',
          name: entry.name,
          base_visibility: entry.base,
          archived_at: entry.archived ? NOW : null,
          created_at: NOW,
          updated_at: NOW,
        })
        .execute()
      if (entry.grant) {
        await db
          .insertInto('project_share_defaults')
          .values({
            id: `matrix-grant-${suffix}`,
            project_container_id: projectId,
            email: viewerEmail.toUpperCase(),
            role: 'viewer',
            created_by_id: 'owner-1',
            created_at: NOW,
            updated_at: NOW,
          })
          .execute()
      }
      if (entry.role && !entry.missing) {
        await db
          .insertInto('workspace_members')
          .values({
            workspace_id: projectWorkspace,
            user_id: viewerId,
            role: entry.role,
            status: entry.status ?? 'active',
            created_at: NOW,
            updated_at: NOW,
          })
          .execute()
      }

      const row = await db
        .selectFrom('artifact_containers as c')
        .leftJoin('users as access_viewer', (join) =>
          join.on(sql<boolean>`${sql.ref('access_viewer.id')} = ${viewerId}`),
        )
        .select([
          ...projectAccessFactSelections('c', 'access_viewer'),
          sql<number>`CASE WHEN ${projectAccessAllowedSql('c', 'access_viewer')} THEN 1 ELSE 0 END`.as(
            'sql_allowed',
          ),
        ])
        .where('c.id', '=', projectId)
        .executeTakeFirstOrThrow()
      const oracle = projectAccessAllowed(
        projectAccessFactsFromRow(row as typeof row & ProjectAccessFactsRow),
      )
      expect(Boolean(row.sql_allowed), entry.name).toBe(oracle)
    }
  })
})
