import { sql, type Kysely } from 'kysely'
import type { DB } from '~/types/db'
import { commentThreadWindowExpression } from './comment-thread-window.server'

export type ViewerRevisitContext = {
  entryCurrentVersionId: string
  version:
    | { kind: 'ordinal'; from: number; to: number }
    | { kind: 'fallback' }
    | null
  commentCount: number
}

type HistoryVersion = { id: string; ordinal: number }

export async function loadViewerRevisitContext(
  db: Kysely<DB>,
  input: {
    shareableId: string
    viewerUserId: string
    currentVersionId: string
    versions: ReadonlyArray<HistoryVersion>
  },
): Promise<ViewerRevisitContext | null> {
  const row = await db
    .selectFrom('shareable_viewer_recency as recency')
    .select([
      'recency.version_seen_through_at as versionBoundary',
      sql<number>`(
        SELECT COUNT(*) FROM versions v
        WHERE v.shareable_id = ${input.shareableId}
          AND v.status = 'published'
          AND v.created_by_id <> ${input.viewerUserId}
          AND (recency.version_seen_through_at IS NULL OR v.published_at > recency.version_seen_through_at)
      )`.as('versionCount'),
      sql<number>`(
        SELECT COUNT(*) FROM comment_messages cm
        INNER JOIN comment_threads ct ON ct.id = cm.thread_id
        WHERE ct.shareable_id = ${input.shareableId}
          AND ${commentThreadWindowExpression(sql.val(input.shareableId), 'ct')}
          AND cm.created_by_id <> ${input.viewerUserId}
          AND (recency.comment_seen_through_at IS NULL OR cm.created_at > recency.comment_seen_through_at)
      )`.as('commentCount'),
      sql<string | null>`(
        SELECT pv.id FROM versions pv
        WHERE pv.shareable_id = ${input.shareableId}
          AND pv.status = 'published'
          AND pv.published_at <= recency.version_seen_through_at
        ORDER BY pv.published_at DESC, pv.created_at DESC, pv.id DESC
        LIMIT 1
      )`.as('previousVersionId'),
      sql<number>`(
        SELECT COUNT(*) FROM versions tied
        WHERE tied.shareable_id = ${input.shareableId}
          AND tied.status = 'published'
          AND tied.published_at = (
            SELECT MAX(candidate.published_at) FROM versions candidate
            WHERE candidate.shareable_id = ${input.shareableId}
              AND candidate.status = 'published'
              AND candidate.published_at <= recency.version_seen_through_at
          )
      )`.as('previousTimestampCount'),
      sql<string | null>`(
        SELECT current.created_by_id FROM versions current
        WHERE current.id = ${input.currentVersionId}
      )`.as('currentCreatedById'),
    ])
    .where('recency.shareable_id', '=', input.shareableId)
    .where('recency.viewer_user_id', '=', input.viewerUserId)
    .executeTakeFirst()

  if (!row) return null
  const versionCount = Number(row.versionCount ?? 0)
  const commentCount = Number(row.commentCount ?? 0)
  let version: ViewerRevisitContext['version'] = null

  if (versionCount > 0) {
    const previous = input.versions.find(
      (candidate) => candidate.id === row.previousVersionId,
    )
    const current = input.versions.find(
      (candidate) => candidate.id === input.currentVersionId,
    )
    const useFallback =
      row.versionBoundary === null ||
      Number(row.previousTimestampCount ?? 0) !== 1 ||
      !previous ||
      !current ||
      previous.ordinal >= current.ordinal ||
      row.currentCreatedById === input.viewerUserId
    version = useFallback
      ? { kind: 'fallback' }
      : { kind: 'ordinal', from: previous.ordinal, to: current.ordinal }
  }

  if (!version && commentCount === 0) return null
  return {
    entryCurrentVersionId: input.currentVersionId,
    version,
    commentCount,
  }
}
