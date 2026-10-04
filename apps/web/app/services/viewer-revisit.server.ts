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
  newCommentMessages: Array<{ messageId: string; threadId: string }>
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
      'recency.comment_seen_through_at as commentBoundary',
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
  // Both queries use the same captured boundary before the loader records this visit.
  const eligibleMessages = db
    .selectFrom('comment_messages as cm')
    .innerJoin('comment_threads as ct', 'ct.id', 'cm.thread_id')
    .where('ct.shareable_id', '=', input.shareableId)
    .where(commentThreadWindowExpression(sql.val(input.shareableId), 'ct'))
    .where('cm.created_by_id', '<>', input.viewerUserId)
    .$if(row.commentBoundary !== null, (query) =>
      query.where('cm.created_at', '>', row.commentBoundary!),
    )
  const [count, newCommentMessages] = await Promise.all([
    eligibleMessages
      .select(sql<number>`COUNT(*)`.as('count'))
      .executeTakeFirstOrThrow(),
    eligibleMessages
      .select(['cm.id as messageId', 'ct.id as threadId'])
      .orderBy('cm.created_at', 'asc')
      .orderBy('cm.id', 'asc')
      .limit(100)
      .execute(),
  ])
  const commentCount = Number(count.count)
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
    newCommentMessages,
  }
}
