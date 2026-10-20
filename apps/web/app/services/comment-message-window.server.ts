import { batchRows, runD1BatchWithResults } from '~/lib/d1-batch.server'
import {
  messageCursor,
  parseMessageCursor,
  type MessageBoundary,
} from '~/lib/comment-cursor'
export { messageCursor, parseMessageCursor } from '~/lib/comment-cursor'
import { sql, type Kysely } from 'kysely'
import type { CommentMessageView } from '~/lib/comments'
import type { DB } from '~/types/db'

import {
  COMMENT_REPLY_PAGE_LIMIT,
  validateCommentPageRequest,
  type CommentPageRequest,
} from '~/lib/comment-page'
export {
  COMMENT_REPLY_PAGE_LIMIT,
  type CommentPageRequest,
} from '~/lib/comment-page'

/** Select IDs using the covering tuple index before loading bodies and authors. */
export async function loadMessageWindow(
  db: Kysely<DB>,
  threadId: string,
  userId: string,
  moderator: boolean,
  request: CommentPageRequest = {},
) {
  const limit = request.limit ?? COMMENT_REPLY_PAGE_LIMIT
  if (validateCommentPageRequest(threadId, request).kind !== 'thread')
    return { kind: 'invalid-page' } as const
  let boundary: MessageBoundary | null = null
  if (request.before !== undefined || request.through !== undefined) {
    boundary = parseMessageCursor(request.before ?? request.through!, threadId)
    if (!boundary) return { kind: 'invalid-page' } as const
  }
  if (request.aroundMessageId !== undefined) {
    const target = await db
      .selectFrom('comment_messages')
      .select(['id', 'created_at'])
      .where('id', '=', request.aroundMessageId)
      .where('thread_id', '=', threadId)
      .executeTakeFirst()
    if (!target) return { kind: 'not-found' } as const
    boundary = { id: target.id, createdAt: target.created_at }
  }
  const first = await db
    .selectFrom('comment_messages')
    .select(['id', 'created_at'])
    .where('thread_id', '=', threadId)
    .orderBy('created_at')
    .orderBy('id')
    .limit(1)
    .executeTakeFirst()
  if (!first)
    return {
      kind: 'ok',
      messages: [] as CommentMessageView[],
      olderCursor: null,
      page: { before: null, through: null },
    } as const
  let ids = db
    .selectFrom('comment_messages')
    .select('id')
    .where('thread_id', '=', threadId)
    .where('id', '!=', first.id)
  if (boundary) {
    ids = ids.where(
      request.aroundMessageId !== undefined
        ? sql<boolean>`(created_at, id) >= (${boundary.createdAt}, ${boundary.id})`
        : request.through !== undefined
          ? sql<boolean>`(created_at, id) <= (${boundary.createdAt}, ${boundary.id})`
          : sql<boolean>`(created_at, id) < (${boundary.createdAt}, ${boundary.id})`,
    )
  }
  const direction = request.aroundMessageId ? 'asc' : 'desc'
  const replyIds = ids
    .orderBy('created_at', direction)
    .orderBy('id', direction)
    .limit(boundary ? limit : 3)
  const replies = await db
    .selectFrom('comment_messages')
    .select(['id', 'created_at'])
    .where('id', 'in', replyIds)
    .orderBy('created_at')
    .orderBy('id')
    .execute()
  const messages = await messageRows(db)
    .where('comment_messages.id', 'in', [
      first.id,
      ...replies.map((row) => row.id),
    ])
    .orderBy('comment_messages.created_at')
    .orderBy('comment_messages.id')
    .execute()
  const oldest = replies[0]
  const older = oldest
    ? await db
        .selectFrom('comment_messages')
        .select('id')
        .where('thread_id', '=', threadId)
        .where('id', '!=', first.id)
        .where(
          sql<boolean>`(created_at, id) < (${oldest.created_at}, ${oldest.id})`,
        )
        .limit(1)
        .executeTakeFirst()
    : undefined
  return {
    kind: 'ok' as const,
    messages: messages.map((message) =>
      messageView(message, userId, moderator),
    ),
    olderCursor:
      older && oldest
        ? messageCursor(threadId, {
            id: oldest.id,
            createdAt: oldest.created_at,
          })
        : null,
    page: {
      before: request.before ?? null,
      through:
        request.through ??
        (request.aroundMessageId && replies.at(-1)
          ? messageCursor(threadId, {
              id: replies.at(-1)!.id,
              createdAt: replies.at(-1)!.created_at,
            })
          : null),
    },
  }
}

export function parseCommentPageQuery(
  params: URLSearchParams,
):
  | { kind: 'panel' }
  | { kind: 'thread'; threadId: string; request: CommentPageRequest }
  | { kind: 'invalid-page' } {
  const keys = ['thread_id', 'before', 'through', 'limit', 'around_message_id']
  if (!keys.some((key) => params.has(key))) return { kind: 'panel' }
  if (keys.some((key) => params.getAll(key).length > 1))
    return { kind: 'invalid-page' }
  const threadId = params.get('thread_id')
  const through = params.get('through') ?? undefined
  const before = params.get('before') ?? undefined
  const aroundMessageId = params.get('around_message_id') ?? undefined
  const rawLimit = params.get('limit')
  const limit = rawLimit === null ? undefined : Number(rawLimit)
  if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit))
    return { kind: 'invalid-page' }
  return validateCommentPageRequest(threadId ?? undefined, {
    before,
    through,
    aroundMessageId,
    limit,
  })
}

function messageRows(db: Kysely<DB>) {
  return db
    .selectFrom('comment_messages')
    .innerJoin('users', 'users.id', 'comment_messages.created_by_id')
    .select([
      'comment_messages.id',
      'comment_messages.body',
      'comment_messages.agent',
      'comment_messages.created_at',
      'comment_messages.updated_at',
      'users.id as author_id',
      'users.email as author_email',
      'users.name as author_name',
      'users.image as author_image',
      'users.kind as author_kind',
    ])
}
type MessageRow = Awaited<
  ReturnType<ReturnType<typeof messageRows>['execute']>
>[number]

function messageView(
  message: MessageRow,
  userId: string,
  moderator: boolean,
): CommentMessageView {
  return {
    id: message.id,
    body: message.body,
    agent: message.agent,
    createdAt: message.created_at,
    updatedAt: message.updated_at,
    author: {
      id: message.author_id,
      email: message.author_email,
      name: message.author_name,
      image: message.author_image,
      kind: message.author_kind,
    },
    canEdit: message.author_id === userId,
    canDelete: message.author_id === userId || moderator,
  }
}

/** Each indexed subquery visits only the first row or latest four replies.
 * The extra reply establishes continuation; batching avoids per-thread RPCs. */
export async function loadInitialMessageWindows(
  db: Kysely<DB>,
  threadIds: string[],
  userId: string,
  moderator: boolean,
) {
  const queries = threadIds.map((threadId) => {
    const first = db
      .selectFrom('comment_messages')
      .select('id')
      .where('thread_id', '=', threadId)
      .orderBy('created_at')
      .orderBy('id')
      .limit(1)
    const latest = db
      .selectFrom('comment_messages')
      .select('id')
      .where('thread_id', '=', threadId)
      .where('id', '!=', first)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(4)
    const ids = db
      .selectFrom(first.as('first'))
      .select('id')
      .unionAll(db.selectFrom(latest.as('latest')).select('id'))
    return messageRows(db)
      .where('comment_messages.id', 'in', ids)
      .orderBy('comment_messages.created_at')
      .orderBy('comment_messages.id')
  })
  // 25 statements per batch, each well below D1's 100-bind statement limit.
  const batches = await Promise.all(
    Array.from({ length: Math.ceil(queries.length / 25) }, (_, index) =>
      runD1BatchWithResults(db, ...queries.slice(index * 25, (index + 1) * 25)),
    ),
  )
  return batches.flat().map((result, index) => {
    const rows = batchRows<MessageRow>(result)
    const replies = rows.slice(1)
    const hasOlder = replies.length > 3
    const selected = hasOlder ? [rows[0], ...replies.slice(-3)] : rows
    return {
      kind: 'ok' as const,
      messages: selected.map((row) => messageView(row, userId, moderator)),
      olderCursor: hasOlder
        ? messageCursor(threadIds[index], {
            id: selected[1].id,
            createdAt: selected[1].created_at,
          })
        : null,
      page: { before: null, through: null },
    }
  })
}
