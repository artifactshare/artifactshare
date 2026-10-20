import { sql, type Kysely } from 'kysely'
import type { DB } from '~/types/db'

export type CommentPostRefusal =
  | { kind: 'thread-capacity' }
  | { kind: 'rate-limited'; retry_after_seconds: number; retry_at: string }

/** One reusable durable row per verified actor/artifact, shared by all transports.
 * Validation happens before admission. Subsequent failures are charged, without
 * refunds. The fixed UTC window intentionally permits bursts across boundaries.
 */
export async function admitCommentPost(
  db: Kysely<DB>,
  userId: string,
  shareableId: string,
  now = Date.now(),
): Promise<{ kind: 'ok' } | CommentPostRefusal | { kind: 'commit-failed' }> {
  const minute = Math.floor(now / 60_000) * 60_000
  try {
    const result = await db
      .insertInto('comment_post_windows')
      .values({
        user_id: userId,
        shareable_id: shareableId,
        minute_start: minute,
        admissions: 1,
      })
      .onConflict((oc) =>
        oc
          .columns(['user_id', 'shareable_id'])
          .doUpdateSet({
            minute_start: sql<number>`MAX(comment_post_windows.minute_start, ${minute})`,
            admissions: sql<number>`CASE WHEN comment_post_windows.minute_start < ${minute} THEN 1 ELSE comment_post_windows.admissions + 1 END`,
          })
          .where((eb) =>
            eb.or([
              eb('comment_post_windows.minute_start', '<', minute),
              eb('comment_post_windows.admissions', '<', 20),
            ]),
          ),
      )
      .returning('admissions')
      .executeTakeFirst()
    if (result) return { kind: 'ok' }
    const window = await db
      .selectFrom('comment_post_windows')
      .select('minute_start')
      .where('user_id', '=', userId)
      .where('shareable_id', '=', shareableId)
      .executeTakeFirstOrThrow()
    const windowEnd = Math.max(minute, window.minute_start) + 60_000
    return {
      kind: 'rate-limited',
      retry_after_seconds: Math.max(1, Math.ceil((windowEnd - now) / 1000)),
      retry_at: new Date(windowEnd).toISOString(),
    }
  } catch {
    return { kind: 'commit-failed' }
  }
}

export async function commentInsertFailure(
  db: Kysely<DB>,
  shareableId: string,
  threadId: string,
  error: unknown,
): Promise<{
  kind: 'thread-capacity' | 'closed-thread' | 'commit-failed'
}> {
  // D1 can wrap trigger errors in both message and cause; match our token only.
  let signal: 'thread-capacity' | 'closed-thread' | undefined
  const seen = new Set<unknown>()
  while (error && !seen.has(error)) {
    seen.add(error)
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('comment_thread_capacity')) signal = 'thread-capacity'
    else if (message.includes('comment_thread_closed')) signal = 'closed-thread'
    if (signal) break
    error = error instanceof Error ? error.cause : undefined
  }
  if (signal) {
    try {
      const thread = await db
        .selectFrom('comment_threads')
        .select(['message_count', 'status'])
        .where('id', '=', threadId)
        .where('shareable_id', '=', shareableId)
        .executeTakeFirst()
      if (
        (signal === 'thread-capacity' &&
          thread &&
          thread.message_count >= 500) ||
        (signal === 'closed-thread' && thread?.status === 'resolved')
      )
        return { kind: signal }
    } catch {
      // A failed confirmation cannot establish a policy refusal.
    }
  }
  return { kind: 'commit-failed' }
}
