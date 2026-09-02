import type { Kysely } from 'kysely'
import type { ArtifactKind } from '~/lib/shareable-types'
import type { SessionUser } from '~/lib/user'
import {
  capSource,
  shareUrl,
  singleFileFormat,
  toAgentCommentThread,
  type ArtifactSourceFormat,
} from '~/services/artifact-readback.server'
import {
  COMMENT_THREAD_LIST_LIMIT,
  loadCommentAccess,
  loadCommentThreads,
} from '~/services/comments.server'
import { fetchArtifactSource } from '~/services/content.server'
import {
  listArtifactVersions,
  listOwnedArtifactVersions,
} from '~/services/shareables.server'
import type { DB } from '~/types/db'

export type ArtifactReadbackInclude = 'versions' | 'comments'

export type ArtifactReadbackResult =
  | { kind: 'ok'; data: ArtifactReadbackData }
  | { kind: 'not-found' }
  | { kind: 'unsupported-kind'; artifactKind: string }
  | { kind: 'source-unavailable' }

export type ArtifactReadbackData = {
  id: string
  share_url: string
  version_id: string
  format: ArtifactSourceFormat
  content: string
  size_bytes: number
  truncated: boolean
  next_offset: number | null
  link_expires_at: string | null
  project_id: string | null
  versions?: Array<{
    version_id: string
    status: string
    size_bytes: number
    created_at: string
    published_at: string | null
    is_current: boolean
    creator: {
      kind: 'human' | 'agent'
      name: string
      email: string | null
      agent_profile_id: string | null
    } | null
  }>
  versions_has_more?: boolean
  comments?: ReturnType<typeof toAgentCommentThread>[]
  comments_has_more?: boolean
}

export async function getArtifactReadback(
  db: Kysely<DB>,
  user: SessionUser,
  args: {
    id: string
    baseUrl: string
    offset?: number
    include?: ArtifactReadbackInclude[]
    includeSharedVersions?: boolean
  },
): Promise<ArtifactReadbackResult> {
  const access = await loadCommentAccess(db, user, args.id)
  if (!access) return { kind: 'not-found' }

  const format = singleFileFormat(access.artifactKind as ArtifactKind)
  if (!format) {
    return { kind: 'unsupported-kind', artifactKind: access.artifactKind }
  }
  if (!access.currentVersionId || !access.r2Key) {
    return { kind: 'source-unavailable' }
  }

  const fetched = await fetchArtifactSource(access.r2Key)
  if (fetched.kind !== 'ok') return { kind: 'source-unavailable' }

  const { content, truncated, nextOffset } = capSource(
    fetched.body,
    args.offset ?? 0,
  )
  const data: ArtifactReadbackData = {
    id: args.id,
    share_url: shareUrl(args.baseUrl, args.id),
    version_id: access.currentVersionId,
    format,
    content,
    size_bytes: fetched.sizeBytes,
    truncated,
    next_offset: nextOffset,
    link_expires_at: access.linkExpiresAt,
    project_id: access.projectId ?? null,
  }

  const include = new Set(args.include ?? [])
  const isOwner = access.ownerUserId === user.id
  await Promise.all([
    (async () => {
      if (!include.has('versions') || (!isOwner && !args.includeSharedVersions))
        return
      const history = isOwner
        ? await listOwnedArtifactVersions(db, user, args.id)
        : await listArtifactVersions(db, args.id, access.currentVersionId)
      const maySeeEmail = access.workspaceId === user.workspaceId
      data.versions = (history?.versions ?? []).map((version) => ({
        version_id: version.versionId,
        status: version.status,
        size_bytes: version.sizeBytes,
        created_at: version.createdAt,
        published_at: version.publishedAt,
        is_current: version.isCurrent,
        creator: version.creator
          ? {
              kind: version.creator.kind,
              name: version.creator.name,
              email: maySeeEmail ? version.creator.email : null,
              agent_profile_id: version.creator.agentProfileId,
            }
          : null,
      }))
      data.versions_has_more = history?.hasMore ?? false
    })(),
    (async () => {
      if (!include.has('comments')) return
      const threads = await loadCommentThreads(db, access, user)
      data.comments = threads.map(toAgentCommentThread)
      data.comments_has_more = threads.length >= COMMENT_THREAD_LIST_LIMIT
    })(),
  ])

  return { kind: 'ok', data }
}
