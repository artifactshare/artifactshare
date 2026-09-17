import { sql, type Kysely } from 'kysely'
import { lowerEmail } from '~/lib/grant-emails.server'
import type { Visibility } from '~/lib/shareable-types'
import type { DB } from '~/types/db'

type AccessSqlValue = string | ReturnType<typeof sql.ref>

function accessSqlValue(value: AccessSqlValue) {
  return typeof value === 'string' ? sql`${value}` : value
}

/**
 * The live workspace access that an old creator/owner identity may not use.
 * Keep the membership and stopped-bot meanings together so read and write
 * paths cannot drift apart.
 */
export async function isWorkspaceAccessRevoked(
  db: Kysely<DB>,
  workspaceId: string,
  userId: string,
): Promise<boolean> {
  const row = await db
    .selectFrom('users as access_revoked_user')
    .select('access_revoked_user.id')
    .where('access_revoked_user.id', '=', userId)
    .where(
      sql<boolean>`(
        EXISTS (
          SELECT 1
          FROM workspace_members access_revoked_member
          WHERE access_revoked_member.workspace_id = ${workspaceId}
            AND access_revoked_member.user_id = ${userId}
            AND access_revoked_member.status = 'removed'
        )
        OR (
          access_revoked_user.kind = 'bot'
          AND access_revoked_user.bot_stopped_at IS NOT NULL
        )
      )`,
    )
    .executeTakeFirst()
  return row !== undefined
}

/** SQL equivalent of isWorkspaceAccessRevoked for correlated predicates. */
export function workspaceAccessRevokedSql(
  workspaceId: AccessSqlValue,
  userId: AccessSqlValue,
) {
  const workspace = accessSqlValue(workspaceId)
  const user = accessSqlValue(userId)
  return sql<boolean>`(
    EXISTS (
      SELECT 1
      FROM users access_revoked_user
      WHERE access_revoked_user.id = ${user}
        AND (
          (
            access_revoked_user.kind = 'bot'
            AND access_revoked_user.bot_stopped_at IS NOT NULL
          )
          OR EXISTS (
            SELECT 1
            FROM workspace_members access_revoked_member
            WHERE access_revoked_member.workspace_id = ${workspace}
              AND access_revoked_member.user_id = access_revoked_user.id
              AND access_revoked_member.status = 'removed'
          )
        )
    )
  )`
}

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
  workspaceAccessRevoked: boolean
}

type ViewerAccessFactsRow = ProjectAccessFactsRow & {
  visibility: Visibility
  owner_user_id: string
  artifact_workspace_id: string
  anonymous_link_allowed: number
  link_suspended: number
  is_team_admin: number
  has_shareable_grant: number
}

export type LoadedViewerAccessFacts = ViewerAccessFacts & {
  /** Needed by the apex viewer to preserve its suspended-link response. */
  linkSuspended: boolean
}

/** Database-owned facts needed to decide whether a project belongs in a list. */
export type ProjectAccessFacts = {
  viewerUserId: string | null
  viewerWorkspaceId: string | null
  viewerEmailVerified: boolean
  containerKind: 'project' | 'inbox' | null
  containerWorkspaceId: string | null
  containerBaseVisibility: 'workspace' | 'private' | null
  containerArchived: boolean
  isProjectCreator: boolean
  isProjectAdmin: boolean
  hasProjectGrant: boolean
  workspaceAccessRevoked: boolean
}

export type ProjectAccessFactsRow = {
  access_viewer_user_id: string | null
  access_viewer_workspace_id: string | null
  access_viewer_email_verified: number | null
  access_container_kind: 'project' | 'inbox' | null
  access_container_workspace_id: string | null
  access_container_base_visibility: 'workspace' | 'private' | null
  access_container_archived_at: string | null
  access_is_project_creator: number
  access_is_project_admin: number
  access_has_project_grant: number
  access_workspace_access_revoked: number
}

/**
 * Fact projection shared by the single-artifact loader and set-oriented list
 * queries. The caller owns the two aliases and joins the viewer from a trusted
 * user id; no session email or workspace value participates in these facts.
 */
export function projectAccessFactSelections(
  containerAlias: string,
  viewerAlias: string,
  accessWorkspaceAlias = containerAlias,
) {
  const container = (column: string) => sql.ref(`${containerAlias}.${column}`)
  const viewer = (column: string) => sql.ref(`${viewerAlias}.${column}`)
  const accessWorkspace = (column: string) =>
    sql.ref(`${accessWorkspaceAlias}.${column}`)

  return [
    sql<string | null>`${viewer('id')}`.as('access_viewer_user_id'),
    sql<string | null>`${viewer('workspace_id')}`.as(
      'access_viewer_workspace_id',
    ),
    sql<number | null>`${viewer('email_verified')}`.as(
      'access_viewer_email_verified',
    ),
    sql<'project' | 'inbox' | null>`${container('kind')}`.as(
      'access_container_kind',
    ),
    sql<string | null>`${container('workspace_id')}`.as(
      'access_container_workspace_id',
    ),
    sql<'workspace' | 'private' | null>`${container('base_visibility')}`.as(
      'access_container_base_visibility',
    ),
    sql<string | null>`${container('archived_at')}`.as(
      'access_container_archived_at',
    ),
    sql<number>`CASE WHEN ${container('kind')} = 'project'
      AND ${container('created_by_id')} = ${viewer('id')}
      THEN 1 ELSE 0 END`.as('access_is_project_creator'),
    sql<number>`CASE WHEN ${workspaceAccessRevokedSql(
      accessWorkspace('workspace_id'),
      viewer('id'),
    )} THEN 1 ELSE 0 END`.as('access_workspace_access_revoked'),
    sql<number>`EXISTS(
      SELECT 1 FROM workspace_members access_wm
      JOIN workspaces access_w ON access_w.id = access_wm.workspace_id
      WHERE ${container('kind')} = 'project'
        AND access_wm.workspace_id = ${container('workspace_id')}
        AND access_wm.user_id = ${viewer('id')}
        AND ${viewer('workspace_id')} = ${container('workspace_id')}
        AND access_wm.status = 'active'
        AND access_wm.role IN ('owner', 'admin')
        AND access_w.plan = 'team'
    )`.as('access_is_project_admin'),
    sql<number>`EXISTS(
      SELECT 1 FROM project_share_defaults access_psd
      WHERE access_psd.project_container_id = ${container('id')}
        AND ${lowerEmail('access_psd.email')} = ${lowerEmail(
          `${viewerAlias}.email`,
        )}
    )`.as('access_has_project_grant'),
  ] as const
}

export function projectAccessFactsFromRow(
  row: ProjectAccessFactsRow,
): ProjectAccessFacts {
  return {
    viewerUserId: row.access_viewer_user_id,
    viewerWorkspaceId: row.access_viewer_workspace_id,
    viewerEmailVerified: row.access_viewer_email_verified === 1,
    containerKind: row.access_container_kind,
    containerWorkspaceId: row.access_container_workspace_id,
    containerBaseVisibility: row.access_container_base_visibility,
    containerArchived: row.access_container_archived_at !== null,
    isProjectCreator: row.access_is_project_creator === 1,
    isProjectAdmin: row.access_is_project_admin === 1,
    hasProjectGrant: row.access_has_project_grant === 1,
    workspaceAccessRevoked: row.access_workspace_access_revoked === 1,
  }
}

/** Pure project-list decision; intentionally does not govern agent scope. */
export function projectAccessAllowed(
  projectFacts: ProjectAccessFacts,
): boolean {
  if (!projectFacts.viewerUserId || projectFacts.containerKind !== 'project')
    return false
  if (projectFacts.viewerWorkspaceId === projectFacts.containerWorkspaceId) {
    return (
      (!projectFacts.workspaceAccessRevoked &&
        (projectFacts.containerBaseVisibility === 'workspace' ||
          projectFacts.isProjectCreator)) ||
      projectFacts.isProjectAdmin ||
      (projectFacts.viewerEmailVerified && projectFacts.hasProjectGrant)
    )
  }
  return (
    !projectFacts.containerArchived &&
    projectFacts.viewerEmailVerified &&
    projectFacts.hasProjectGrant
  )
}

/**
 * Set-oriented equivalent of projectAccessAllowed. The aliases must identify
 * artifact_containers and the database-owned viewer row respectively.
 */
export function projectAccessAllowedSql(
  containerAlias: string,
  viewerAlias: string,
) {
  const container = (column: string) => sql.ref(`${containerAlias}.${column}`)
  const viewer = (column: string) => sql.ref(`${viewerAlias}.${column}`)
  return sql<boolean>`(
    ${viewer('id')} IS NOT NULL
    AND ${container('kind')} = 'project'
    AND (
      (
        ${viewer('workspace_id')} = ${container('workspace_id')}
        AND (
          (
            NOT ${workspaceAccessRevokedSql(
              container('workspace_id'),
              viewer('id'),
            )}
            AND (
              ${container('base_visibility')} = 'workspace'
              OR ${container('created_by_id')} = ${viewer('id')}
            )
          )
          OR EXISTS (
            SELECT 1
            FROM workspace_members access_allowed_wm
            JOIN workspaces access_allowed_w
              ON access_allowed_w.id = access_allowed_wm.workspace_id
            WHERE access_allowed_wm.workspace_id = ${container('workspace_id')}
              AND access_allowed_wm.user_id = ${viewer('id')}
              AND access_allowed_wm.status = 'active'
              AND access_allowed_wm.role IN ('owner', 'admin')
              AND access_allowed_w.plan = 'team'
          )
          OR (
            ${viewer('email_verified')} = 1
            AND EXISTS (
              SELECT 1
              FROM project_share_defaults access_allowed_psd
              WHERE access_allowed_psd.project_container_id = ${container('id')}
                AND ${lowerEmail('access_allowed_psd.email')} = ${lowerEmail(
                  `${viewerAlias}.email`,
                )}
            )
          )
        )
      )
      OR (
        ${viewer('workspace_id')} <> ${container('workspace_id')}
        AND ${container('archived_at')} IS NULL
        AND ${viewer('email_verified')} = 1
        AND EXISTS (
          SELECT 1
          FROM project_share_defaults access_allowed_psd
          WHERE access_allowed_psd.project_container_id = ${container('id')}
            AND ${lowerEmail('access_allowed_psd.email')} = ${lowerEmail(
              `${viewerAlias}.email`,
            )}
        )
      )
    )
  )`
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
    .leftJoin(
      'artifact_containers as access_container',
      'access_container.id',
      'shareables.container_id',
    )
    .leftJoin('users as access_viewer', (join) =>
      join.on(
        sql<boolean>`${sql.ref('access_viewer.id')} = ${input.viewerUserId}`,
      ),
    )
    .select([
      'shareables.visibility',
      'shareables.owner_user_id',
      'shareables.workspace_id as artifact_workspace_id',
      ...projectAccessFactSelections(
        'access_container',
        'access_viewer',
        'shareables',
      ),
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
    ])
    .where('shareables.id', '=', input.shareableId)
    .executeTakeFirst()) as ViewerAccessFactsRow | undefined

  if (!row) return null
  const projectFacts = projectAccessFactsFromRow(row)
  return {
    visibility: row.visibility,
    viewerUserId: projectFacts.viewerUserId,
    ownerUserId: row.owner_user_id,
    viewerWorkspaceId: projectFacts.viewerWorkspaceId,
    artifactWorkspaceId: row.artifact_workspace_id,
    viewerEmailVerified: projectFacts.viewerEmailVerified,
    anonymousLinkAllowed: row.anonymous_link_allowed === 1,
    linkSuspended: row.link_suspended === 1,
    isTeamAdmin: row.is_team_admin === 1,
    hasShareableGrant: row.has_shareable_grant === 1,
    containerKind: projectFacts.containerKind,
    containerBaseVisibility: projectFacts.containerBaseVisibility,
    isProjectCreator: projectFacts.isProjectCreator,
    isProjectAdmin: projectFacts.isProjectAdmin,
    hasProjectGrant: projectFacts.hasProjectGrant,
    workspaceAccessRevoked: projectFacts.workspaceAccessRevoked,
  }
}
