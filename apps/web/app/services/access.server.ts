import { sql, type ExpressionBuilder, type Kysely } from 'kysely'
import { redirect } from 'react-router'
import { lowerEmail } from '~/lib/grant-emails.server'
import type { ProjectBaseVisibility, Visibility } from '~/lib/shareable-types'
import type { DB } from '~/types/db'
import { checkAnonymousLinkAccess } from './link-sharing.server'

export const MAX_CONTENT_BYTES = 25 * 1024 * 1024

// Canonical workspace admin membership lookup. Returned as a query builder so
// callers that need an atomic admin re-check (e.g. inside an UPDATE ... WHERE
// EXISTS) reuse the same predicate as the boolean form below.
export function workspaceAdminQuery(
  db: Kysely<DB>,
  userId: string,
  workspaceId: string,
) {
  return db
    .selectFrom('workspace_members')
    .select('user_id')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId)
    .where('role', 'in', ['owner', 'admin'])
    .where('status', '=', 'active')
}

/**
 * Whether the user is an admin of the given workspace. Admin rights never cross
 * workspace boundaries, so a workspace mismatch is denied before any read.
 *
 * Use this only for all-plan workspace settings. Team-only management features
 * must use `isTeamWorkspaceAdmin`.
 */
export async function isWorkspaceAdmin(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  workspaceId: string,
): Promise<boolean> {
  if (user.workspaceId !== workspaceId) return false
  const row = await workspaceAdminQuery(
    db,
    user.id,
    workspaceId,
  ).executeTakeFirst()
  return Boolean(row)
}

export async function isTeamWorkspaceAdmin(
  db: Kysely<DB>,
  user: { id: string; workspaceId: string },
  workspaceId: string,
): Promise<boolean> {
  if (user.workspaceId !== workspaceId) return false
  const row = await workspaceAdminQuery(db, user.id, workspaceId)
    .innerJoin('workspaces', 'workspaces.id', 'workspace_members.workspace_id')
    .where('workspaces.plan', '=', 'team')
    .executeTakeFirst()
  return Boolean(row)
}

export async function requireInventoryAccess(
  db: Parameters<typeof isTeamWorkspaceAdmin>[0],
  user: Parameters<typeof isTeamWorkspaceAdmin>[1],
) {
  if (!(await isTeamWorkspaceAdmin(db, user, user.workspaceId)))
    throw redirect('/settings')
}

export interface ArtifactSnapshot {
  id: string
  modifiedTime: string | null
  name: string
  mimeType: string
  ownerEmail: string | null
}

export type ViewerDisplayCheck =
  | { kind: 'access-granted'; meta: ArtifactSnapshot }
  | { kind: 'access-denied' }
  | { kind: 'meta-unavailable' }

export interface ViewerDisplayContext {
  shareableId: string
  ownerUserId: string
  artifactWorkspaceId: string
  viewerWorkspaceId: string | null
  viewerEmail: string | null
  // Whether viewerEmail is proven. Email-grant access is gated on this.
  viewerEmailVerified: boolean
  containerId: string | null
  // inbox も base_visibility='workspace' を持つため、project のときだけ使う。
  containerKind: 'project' | 'inbox' | null
  containerBaseVisibility: ProjectBaseVisibility | null
  now?: string
}

// Email-grant access requires a proven email. An unverified viewer (e.g. a
// Microsoft tenant that asserts no verification) gets null here, so the
// email-match clauses never match and they must prove the address via the
// email-code flow first. Owner / workspace / creator / admin access is separate
// and unaffected (null binds as SQL NULL, and `col = NULL` is never true).
export function grantMatchEmail(viewer: {
  email: string
  emailVerified: boolean
}): string | null {
  return viewer.emailVerified ? viewer.email.toLowerCase() : null
}

// 呼び出し側が見る人のワークスペース内の成果物に絞り込み済みであることを前提に、
// base_visibility='workspace' を同一ワークスペース向けとして扱う。
// project 可視の成果物を一覧・件数で見られる viewer。所有者一致は呼び出し側
// (visibleShareableToViewer) が別に見る。ここでは「社内全員ベース / プロジェクト
// 作成者 / ワークスペース管理者 / 関係者」を通す。作成者・管理者は private ベースでも
// プロジェクトの中身を管理する立場なので、関係者でなくても見られる。
export function workspaceScopedProjectVisibility(
  eb: ExpressionBuilder<DB, 'shareables'>,
  viewer: {
    id: string
    email: string
    emailVerified: boolean
  },
) {
  return eb.and([
    eb('shareables.visibility', '=', 'project'),
    eb.or([
      eb.exists(
        eb
          .selectFrom('artifact_containers')
          .select('artifact_containers.id')
          .whereRef('artifact_containers.id', '=', 'shareables.container_id')
          .where('artifact_containers.kind', '=', 'project')
          .where(({ or, exists, eb: subEb }) =>
            or([
              subEb('artifact_containers.base_visibility', '=', 'workspace'),
              subEb('artifact_containers.created_by_id', '=', viewer.id),
              exists(
                eb
                  .selectFrom('workspace_members')
                  .innerJoin(
                    'workspaces',
                    'workspaces.id',
                    'workspace_members.workspace_id',
                  )
                  .select('workspace_members.user_id')
                  .where(
                    sql.ref('workspace_members.workspace_id'),
                    '=',
                    sql.ref('artifact_containers.workspace_id'),
                  )
                  .where('workspace_members.user_id', '=', viewer.id)
                  .where('workspace_members.role', 'in', ['owner', 'admin'])
                  .where('workspace_members.status', '=', 'active')
                  .where('workspaces.plan', '=', 'team'),
              ),
            ]),
          ),
      ),
      eb.exists(
        eb
          .selectFrom('project_share_defaults')
          .select('project_share_defaults.project_container_id')
          .whereRef(
            'project_share_defaults.project_container_id',
            '=',
            'shareables.container_id',
          )
          .where(
            lowerEmail('project_share_defaults.email'),
            '=',
            grantMatchEmail(viewer),
          ),
      ),
    ]),
  ])
}

async function canViewerAccessProjectVisibility(
  db: Kysely<DB>,
  context: ViewerDisplayContext,
  viewerUserId: string,
  viewerEmail: string,
): Promise<boolean> {
  if (!context.containerId || context.containerKind !== 'project') return false

  if (
    context.containerBaseVisibility === 'workspace' &&
    context.viewerWorkspaceId === context.artifactWorkspaceId
  ) {
    return true
  }

  // 作成者・ワークスペース管理者は、private ベースでもプロジェクトの project 可視成果物を
  // 見られる (プロジェクトを管理する立場で、関係者リストには載らないため別に通す)。
  const container = await db
    .selectFrom('artifact_containers')
    .select(['created_by_id', 'workspace_id'])
    .where('id', '=', context.containerId)
    .where('kind', '=', 'project')
    .executeTakeFirst()
  if (container) {
    if (container.created_by_id === viewerUserId) return true
    if (
      await isTeamWorkspaceAdmin(
        db,
        { id: viewerUserId, workspaceId: context.viewerWorkspaceId ?? '' },
        container.workspace_id,
      )
    ) {
      return true
    }
  }

  // Audience membership is email-grant access → only for a verified email.
  // (Creator / workspace-admin access above is not email-based and still works.)
  if (!context.viewerEmailVerified) return false
  const audienceMember = await db
    .selectFrom('project_share_defaults')
    .select('email')
    .where('project_container_id', '=', context.containerId)
    .where(lowerEmail('email'), '=', viewerEmail)
    .executeTakeFirst()
  return Boolean(audienceMember)
}

export async function viewerDisplayCheck(
  db: Kysely<DB>,
  visibility: Visibility,
  viewerUserId: string | null,
  publicMeta: ArtifactSnapshot | null,
  context: ViewerDisplayContext,
): Promise<ViewerDisplayCheck> {
  if (visibility === 'link') {
    const linkAccess = await checkAnonymousLinkAccess(
      db,
      context.shareableId,
      context.now,
    )
    if (linkAccess.kind === 'allowed') {
      if (!publicMeta) return { kind: 'meta-unavailable' }
      return { kind: 'access-granted', meta: publicMeta }
    }
    // An expired, disabled, or Free link is denied only when the request has
    // no other authenticated authorization. Owner/grant checks below preserve
    // non-link access that the shareable already granted.
    if (!viewerUserId) return { kind: 'access-denied' }
  }

  if (!viewerUserId) return { kind: 'access-denied' }

  if (viewerUserId === context.ownerUserId) {
    if (!publicMeta) return { kind: 'meta-unavailable' }
    return { kind: 'access-granted', meta: publicMeta }
  }

  if (
    visibility === 'link' &&
    context.viewerWorkspaceId &&
    (await isTeamWorkspaceAdmin(
      db,
      { id: viewerUserId, workspaceId: context.viewerWorkspaceId },
      context.artifactWorkspaceId,
    ))
  ) {
    if (!publicMeta) return { kind: 'meta-unavailable' }
    return { kind: 'access-granted', meta: publicMeta }
  }

  if (
    visibility === 'workspace' &&
    context.viewerWorkspaceId === context.artifactWorkspaceId
  ) {
    if (!publicMeta) return { kind: 'meta-unavailable' }
    return { kind: 'access-granted', meta: publicMeta }
  }

  const viewerEmail = context.viewerEmail?.toLowerCase() ?? null
  if (!viewerEmail) return { kind: 'access-denied' }

  if (visibility === 'project') {
    if (
      await canViewerAccessProjectVisibility(
        db,
        context,
        viewerUserId,
        viewerEmail,
      )
    ) {
      if (!publicMeta) return { kind: 'meta-unavailable' }
      return { kind: 'access-granted', meta: publicMeta }
    }
  }

  // Per-artifact grant is email-grant access → only for a verified email.
  const grant = await db
    .selectFrom('shareable_grants')
    .select('shareable_id')
    .where('shareable_id', '=', context.shareableId)
    .where(
      lowerEmail('granted_email'),
      '=',
      grantMatchEmail({
        email: viewerEmail,
        emailVerified: context.viewerEmailVerified,
      }),
    )
    .executeTakeFirst()

  if (!grant) return { kind: 'access-denied' }
  if (!publicMeta) return { kind: 'meta-unavailable' }
  return { kind: 'access-granted', meta: publicMeta }
}
