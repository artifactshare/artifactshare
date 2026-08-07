import { sql } from 'kysely'

export const COMMENT_THREAD_LIST_LIMIT = 50

export function commentThreadWindowExpression(
  shareableRef: ReturnType<typeof sql.ref> = sql.ref('shareables.id'),
  threadAlias = 'comment_threads',
) {
  const threadId = sql.ref(`${threadAlias}.id`)
  return sql<boolean>`${threadId} IN (
    SELECT panel_threads.id
    FROM comment_threads panel_threads
    WHERE panel_threads.shareable_id = ${shareableRef}
    ORDER BY (panel_threads.status = 'open') DESC,
      panel_threads.updated_at DESC,
      panel_threads.created_at DESC,
      panel_threads.id ASC
    LIMIT ${COMMENT_THREAD_LIST_LIMIT}
  )`
}
