import type { Kysely } from 'kysely'
import type { ArtifactVersionsResponse } from '@artifactshare/contract'
import type { SessionUser } from '~/lib/user'
import type { DB } from '~/types/db'
import type { AgentReadAuthorization } from './agent-scope.server'
import { loadCommentAccess } from './comments.server'
import {
  listArtifactVersions,
  OWNED_VERSION_LIST_LIMIT,
} from './shareables.server'
import { loadArtifactVersionSummaries } from './artifact-version-summary.server'

type Cursor = { artifact: string; created_at: string; id: string }
function decodeCursor(value: string, artifact: string): Cursor | null {
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return null
    const parsed = JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')))
    if (
      parsed.artifact !== artifact ||
      typeof parsed.id !== 'string' ||
      !parsed.id ||
      typeof parsed.created_at !== 'string' ||
      !Number.isFinite(Date.parse(parsed.created_at))
    )
      return null
    return parsed
  } catch {
    return null
  }
}
function encodeCursor(cursor: Cursor) {
  return btoa(JSON.stringify(cursor))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

export async function getArtifactVersions(
  db: Kysely<DB>,
  user: SessionUser,
  args: {
    id: string
    cursor?: string
    agentReadAuthorization?: AgentReadAuthorization
  },
): Promise<
  | { kind: 'ok'; data: ArtifactVersionsResponse }
  | { kind: 'not-found' | 'invalid-cursor' }
> {
  const access = await loadCommentAccess(
    db,
    user,
    args.id,
    args.agentReadAuthorization,
  )
  if (!access) return { kind: 'not-found' }
  const cursor =
    args.cursor === undefined ? undefined : decodeCursor(args.cursor, args.id)
  if (cursor === null) return { kind: 'invalid-cursor' }
  const [history, summaries] = await Promise.all([
    listArtifactVersions(
      db,
      args.id,
      access.currentVersionId,
      cursor,
      access.artifactKind === 'static_site',
    ),
    loadArtifactVersionSummaries(db, [args.id]),
  ])
  const maySeeEmail =
    access.workspaceId ===
    (args.agentReadAuthorization?.viewerWorkspaceId ?? user.workspaceId)
  const last = history.versions.at(-1)
  return {
    kind: 'ok',
    data: {
      id: args.id,
      ...summaries.get(args.id)!,
      versions: history.versions.map((version) => ({
        version_id: version.versionId,
        ...(version.label != null ? { label: version.label } : {}),
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
      })),
      limit: OWNED_VERSION_LIST_LIMIT,
      has_more: history.hasMore,
      next_cursor:
        history.hasMore && last
          ? encodeCursor({
              artifact: args.id,
              created_at: last.createdAt,
              id: last.versionId,
            })
          : null,
    },
  }
}
