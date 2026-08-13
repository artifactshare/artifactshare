import type { ArtifactType } from '~/lib/artifact-type'
import { renderTypeFromKind } from '~/lib/artifact-type'
import { isExternalAuthorEmail, isReservedBotEmail } from '~/lib/grant-emails'
import type { ArtifactKind, Visibility } from '~/lib/shareable-types'
import { getOwnerInitial } from '~/lib/user'

export interface FileRowData {
  id: string
  fileName: string
  derivedTitle: string | null
  titleOverride: string | null
  /** null for legacy rows whose MIME no longer maps to a supported type. */
  renderType: ArtifactType | null
  ownerEmail: string | null
  ownerId: string
  ownerName: string | null
  ownerImage: string | null
  ownerInitial: string
  ownerIsExternal: boolean
  /**
   * Derived from the reserved bot email domain: only server-created bot rows
   * can hold a `.invalid` address (sign-up rejects the domain), so the email
   * is as authoritative as users.kind without widening every list query.
   */
  ownerIsBot?: boolean
  modifiedTime: string | null
  createdTime?: string | null
  versionCount?: number
  latestVersionNumber?: number | null
  latestPublishedAt?: string | null
  unreadVersionCount?: number
  unreadCommentCount?: number
  latestUnreadComment?: {
    id: string
    authorId: string
    authorName: string | null
    authorImage: string | null
    body: string
    createdAt: string
  } | null
  unreadCommentRemainingCount?: number
  recentAttribute?: 'own' | 'joined-project' | 'direct-share' | null
  /** Whether the registered user is the same as the current user. */
  registeredByMe: boolean
  /** Client-side ownership gate for list actions; server authorization is unchanged. */
  isOwner?: boolean
  /** Recent-item placeholder for a shareable the viewer can no longer access. */
  lostAccess?: boolean
  visibility: Visibility
  viewCount: number
  commentCount: number
  projectId?: string | null
  projectName?: string | null
  contextualWorkspaceLabel?: string | null
}

export interface ShareableFileRow {
  id: string
  name: string
  derived_title: string | null
  title_override: string | null
  artifact_kind: ArtifactKind
  owner_user_id: string
  owner_email: string
  owner_name: string | null
  owner_image: string | null
  visibility: Visibility
  view_count: number | null
  comment_count: number | string | bigint | null
  modified_at: string | null
  created_at?: string | null
  version_count?: number | string | bigint | null
  latest_version_number?: number | null
  latest_published_at?: string | null
  unread_version_count?: number | string | bigint | null
  unread_comment_summary?: string | null
  recent_attribute?: 'own' | 'joined-project' | 'direct-share' | null
  project_id?: string | null
  project_name?: string | null
  project_kind?: string | null
  workspace_id?: string | null
  project_workspace_id?: string | null
  project_workspace_name?: string | null
}

export function toFileRowData(
  row: ShareableFileRow,
  currentUserId: string,
  options: {
    includeProject?: boolean
    currentWorkspaceId?: string
    externalContext?: { workspaceHd: string | null; selfEmail?: string | null }
  } = {},
): FileRowData {
  const projectId =
    options.includeProject && row.project_kind === 'project'
      ? row.project_id
      : null
  const projectName =
    options.includeProject && row.project_kind === 'project'
      ? row.project_name
      : null
  const contextualWorkspaceLabel =
    projectName &&
    options.currentWorkspaceId &&
    row.project_workspace_id &&
    row.project_workspace_id !== options.currentWorkspaceId
      ? (row.project_workspace_name ?? null)
      : null
  const unreadCommentSummary = row.unread_comment_summary
    ? (JSON.parse(row.unread_comment_summary) as {
        count: number
        id: string
        author_id: string
        author_name: string | null
        author_image: string | null
        body: string
        created_at: string
      })
    : null
  const unreadCommentCount = unreadCommentSummary
    ? Number(unreadCommentSummary.count)
    : undefined
  const latestUnreadCommentFromRow = unreadCommentSummary?.count
    ? unreadCommentSummary
    : null
  const latestUnreadComment = latestUnreadCommentFromRow
    ? {
        id: latestUnreadCommentFromRow.id,
        authorId: latestUnreadCommentFromRow.author_id,
        authorName: latestUnreadCommentFromRow.author_name,
        authorImage: latestUnreadCommentFromRow.author_image,
        body: latestUnreadCommentFromRow.body,
        createdAt: latestUnreadCommentFromRow.created_at,
      }
    : null

  return {
    id: row.id,
    fileName: row.name,
    derivedTitle: row.derived_title,
    titleOverride: row.title_override,
    renderType: renderTypeFromKind(row.artifact_kind),
    ownerEmail: row.owner_email,
    ownerId: row.owner_user_id,
    ownerName: row.owner_name,
    ownerImage: row.owner_image,
    ownerInitial: getOwnerInitial(row.owner_name, row.owner_email),
    ownerIsBot: isReservedBotEmail(row.owner_email),
    ownerIsExternal: options.externalContext
      ? isExternalAuthorEmail(
          row.owner_email,
          options.externalContext.workspaceHd,
          options.externalContext.selfEmail,
        )
      : false,
    modifiedTime: row.modified_at,
    createdTime: row.created_at,
    versionCount: Number(row.version_count ?? 0),
    latestVersionNumber: row.latest_version_number ?? null,
    latestPublishedAt: row.latest_published_at ?? null,
    unreadVersionCount:
      row.unread_version_count != null
        ? Number(row.unread_version_count)
        : undefined,
    unreadCommentCount,
    latestUnreadComment,
    unreadCommentRemainingCount:
      unreadCommentCount == null
        ? undefined
        : Math.max(0, unreadCommentCount - 1),
    recentAttribute: row.recent_attribute ?? null,
    registeredByMe: row.owner_user_id === currentUserId,
    isOwner: row.owner_user_id === currentUserId,
    visibility: row.visibility,
    viewCount: Number(row.view_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    projectId,
    projectName,
    contextualWorkspaceLabel,
  }
}
