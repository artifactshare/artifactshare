import { sql, type Kysely } from 'kysely'
import type { CommentMessageView } from '~/lib/comments'
import type { DB } from '~/types/db'

export const COMMENT_REPLY_PAGE_LIMIT = 50
export type MessageBoundary = { createdAt: string; id: string }
export type CommentPageRequest = {
  through?: string
  before?: string
  limit?: number
  aroundMessageId?: string
}

export function messageCursor(
  threadId: string,
  boundary: MessageBoundary,
): string {
  return btoa(JSON.stringify([1, threadId, boundary.createdAt, boundary.id]))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

export function parseMessageCursor(
  value: string,
  threadId: string,
): MessageBoundary | null {
  if (!value || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value))
    return null
  try {
    const decoded: unknown = JSON.parse(
      atob(value.replaceAll('-', '+').replaceAll('_', '/')),
    )
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 4 ||
      decoded[0] !== 1 ||
      decoded[1] !== threadId
    )
      return null
    const [, , createdAt, id] = decoded
    if (
      typeof createdAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
      !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== createdAt ||
      typeof id !== 'string' ||
      !/^[\w-]{1,128}$/.test(id)
    )
      return null
    return { createdAt, id }
  } catch {
    return null
  }
}

/** Select IDs using the covering tuple index before loading bodies and authors. */
export async function loadMessageWindow(
  db: Kysely<DB>,
  threadId: string,
  userId: string,
  moderator: boolean,
  request: CommentPageRequest = {},
) {
  const limit = request.limit ?? COMMENT_REPLY_PAGE_LIMIT
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > COMMENT_REPLY_PAGE_LIMIT ||
    [request.before, request.through, request.aroundMessageId].filter(
      (value) => value !== undefined,
    ).length > 1 ||
    (request.limit !== undefined &&
      request.before === undefined &&
      request.through === undefined &&
      request.aroundMessageId === undefined)
  ) {
    return { kind: 'invalid-page' } as const
  }
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
  const messages = await db
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
    messages: messages.map((message): CommentMessageView => ({
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
    })),
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
  if (
    !threadId ||
    threadId.length > 128 ||
    [before, through, aroundMessageId].filter((value) => value !== undefined)
      .length > 1 ||
    (rawLimit !== null &&
      (!/^[1-9]\d*$/.test(rawLimit) ||
        limit! > 50 ||
        (before === undefined &&
          through === undefined &&
          aroundMessageId === undefined))) ||
    aroundMessageId === '' ||
    (aroundMessageId?.length ?? 0) > 128
  )
    return { kind: 'invalid-page' }
  return {
    kind: 'thread',
    threadId,
    request: { before, through, aroundMessageId, limit },
  }
}
