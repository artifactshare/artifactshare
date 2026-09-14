import { sql, type Kysely } from 'kysely'
import { lowerEmail } from '~/lib/grant-emails.server'
import type { Visibility } from '~/lib/shareable-types'
import type { DB } from '~/types/db'

/** The complete set of inputs consumed by the shared viewer access policy. */
export type ViewerAccessFacts = {
  visibility: Visibility
  viewerUserId: string | null
  ownerUserId: string
  viewerWorkspaceId: string | null
  artifactWorkspaceId: string
  viewerEmailVerified: boolean
  anonymousLinkAllowed: boolean
  isTeamAdmin: boolean
  hasShareableGrant: boolean
  containerKind: 'project' | 'inbox' | null
  containerBaseVisibility: 'workspace' | 'private' | null
  isProjectCreator: boolean
  isProjectAdmin: boolean
  hasProjectGrant: boolean
}

type ViewerAccessFactsRow = {
  visibility: Visibility
  viewer_user_id: string | null
  owner_user_id: string
  viewer_workspace_id: string | null
  artifact_workspace_id: string
  viewer_email_verified: number | null
  anonymous_link_allowed: number
  link_suspended: number
  is_team_admin: number
  has_shareable_grant: number
  container_kind: 'project' | 'inbox' | null
  container_base_visibility: 'workspace' | 'private' | null
  is_project_creator: number
  is_project_admin: number
  has_project_grant: number
}

export type LoadedViewerAccessFacts = ViewerAccessFacts & {
  /** Needed by the apex viewer to preserve its suspended-link response. */
  linkSuspended: boolean
}

function activeLinkExpiry(now: string) {
  return sql<boolean>`(shareables.link_expires_at IS NULL OR (
    strftime('%Y-%m-%dT%H:%M:%S', shareables.link_expires_at) = substr(shareables.link_expires_at, 1, 19)
    AND substr(shareables.link_expires_at, -1) = 'Z'
    AND substr(shareables.link_expires_at, 12, 2) BETWEEN '00' AND '23'
    AND (
      length(shareables.link_expires_at) = 20
      OR (
        length(shareables.link_expires_at) > 21
        AND substr(shareables.link_expires_at, 20, 1) = '.'
        AND substr(shareables.link_expires_at, 21, length(shareables.link_expires_at) - 21) NOT GLOB '*[^0-9]*'
      )
    )
    AND julianday(shareables.link_expires_at) > julianday(${now})
  ))`
}

/**
 * Load the database-owned facts used by the viewer authorization policy.
 *
 * The caller supplies only identity and time. Viewer workspace, email, and
 * verification state are read from the user row so callers cannot accidentally
 * authorize from stale session attributes.
 */
export async function facts(
  db: Kysely<DB>,
  input: {
    shareableId: string
    viewerUserId: string | null
    now: string
  },
): Promise<LoadedViewerAccessFacts | null> {
  const row = (await db
    .selectFrom('shareables')
    .leftJoin('users as access_viewer', (join) =>
      join.on(
        sql<boolean>`${sql.ref('access_viewer.id')} = ${input.viewerUserId}`,
      ),
    )
    .select([
      'shareables.visibility',
      'access_viewer.id as viewer_user_id',
      'shareables.owner_user_id',
      'access_viewer.workspace_id as viewer_workspace_id',
      'shareables.workspace_id as artifact_workspace_id',
      'access_viewer.email_verified as viewer_email_verified',
      sql<string | null>`(
        SELECT kind FROM artifact_containers
        WHERE id = shareables.container_id
      )`.as('container_kind'),
      sql<string | null>`(
        SELECT base_visibility FROM artifact_containers
        WHERE id = shareables.container_id
      )`.as('container_base_visibility'),
      sql<number>`CASE WHEN shareables.visibility = 'link'
        AND shareables.link_suspended_at IS NULL
        AND (${activeLinkExpiry(input.now)})
        AND EXISTS(
          SELECT 1 FROM workspaces link_workspace
          WHERE link_workspace.id = shareables.workspace_id
            AND link_workspace.link_sharing_enabled = 1
        ) THEN 1 ELSE 0 END`.as('anonymous_link_allowed'),
      sql<number>`CASE WHEN shareables.visibility = 'link'
        AND shareables.link_suspended_at IS NOT NULL
        AND EXISTS(
          SELECT 1 FROM workspaces link_workspace
          WHERE link_workspace.id = shareables.workspace_id
            AND link_workspace.link_sharing_enabled = 1
        )
        THEN 1 ELSE 0 END`.as('link_suspended'),
      sql<number>`EXISTS(
        SELECT 1 FROM workspace_members wm
        JOIN workspaces w ON w.id = wm.workspace_id
        WHERE wm.workspace_id = shareables.workspace_id
          AND wm.user_id = access_viewer.id
          AND access_viewer.workspace_id = shareables.workspace_id
          AND wm.status = 'active'
          AND wm.role IN ('owner', 'admin')
          AND w.plan = 'team'
      )`.as('is_team_admin'),
      sql<number>`EXISTS(
        SELECT 1 FROM shareable_grants sg
        WHERE sg.shareable_id = shareables.id
          AND ${lowerEmail('sg.granted_email')} = ${lowerEmail('access_viewer.email')}
      )`.as('has_shareable_grant'),
      sql<number>`EXISTS(
        SELECT 1 FROM artifact_containers ac
        WHERE ac.id = shareables.container_id
          AND ac.kind = 'project'
          AND ac.created_by_id = access_viewer.id
      )`.as('is_project_creator'),
      sql<number>`EXISTS(
        SELECT 1 FROM artifact_containers ac
        JOIN workspace_members wm ON wm.workspace_id = ac.workspace_id
        JOIN workspaces w ON w.id = ac.workspace_id
        WHERE ac.id = shareables.container_id
          AND ac.kind = 'project'
          AND wm.user_id = access_viewer.id
          AND access_viewer.workspace_id = ac.workspace_id
          AND wm.status = 'active'
          AND wm.role IN ('owner', 'admin')
          AND w.plan = 'team'
      )`.as('is_project_admin'),
      sql<number>`EXISTS(
        SELECT 1 FROM project_share_defaults psd
        WHERE psd.project_container_id = shareables.container_id
          AND ${lowerEmail('psd.email')} = ${lowerEmail('access_viewer.email')}
      )`.as('has_project_grant'),
    ])
    .where('shareables.id', '=', input.shareableId)
    .executeTakeFirst()) as ViewerAccessFactsRow | undefined

  if (!row) return null
  return {
    visibility: row.visibility,
    viewerUserId: row.viewer_user_id,
    ownerUserId: row.owner_user_id,
    viewerWorkspaceId: row.viewer_workspace_id,
    artifactWorkspaceId: row.artifact_workspace_id,
    viewerEmailVerified: row.viewer_email_verified === 1,
    anonymousLinkAllowed: row.anonymous_link_allowed === 1,
    linkSuspended: row.link_suspended === 1,
    isTeamAdmin: row.is_team_admin === 1,
    hasShareableGrant: row.has_shareable_grant === 1,
    containerKind: row.container_kind,
    containerBaseVisibility: row.container_base_visibility,
    isProjectCreator: row.is_project_creator === 1,
    isProjectAdmin: row.is_project_admin === 1,
    hasProjectGrant: row.has_project_grant === 1,
  }
}
