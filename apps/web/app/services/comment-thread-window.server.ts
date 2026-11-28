import { sql } from 'kysely'

export const COMMENT_THREAD_LIST_LIMIT = 50

/**
 * The thread window the comment panel shows, as a predicate on one thread row.
 *
 * Both arguments name what the enclosing query must have in scope:
 * `shareableRef` is the shareable id the window is taken for, either a
 * reference to a column of the enclosing query or a bound value, and
 * `threadAlias` is the name the enclosing query gives the `comment_threads`
 * row the predicate applies to.
 */
export function commentThreadWindowExpression(
  shareableRef: ReturnType<typeof sql.ref>,
  threadAlias: string,
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
