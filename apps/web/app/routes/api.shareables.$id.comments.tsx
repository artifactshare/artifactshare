import { errorResponse } from '~/lib/api-errors'
import { MAX_COMMENT_BODY_LENGTH } from '~/lib/comments'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { ctxContext, requireUser } from '~/middleware/context'
import {
  changeComment,
  createCommentThread,
  loadCommentAccess,
  loadCommentThreads,
  replyToCommentThread,
} from '~/services/comments.server'
import { createDb } from '~/services/db.server'
import type { Route } from './+types/api.shareables.$id.comments'

export const middleware = [requireUserApiMiddleware]

export async function loader({ context, params }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const access = await loadCommentAccess(db, user, params.id)
  if (!access) return errorResponse('not-found', 'Shareable not found.', 404)
  return Response.json({
    threads: await loadCommentThreads(db, access, user),
  })
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const user = requireUser(context)

  const payload = parseCommentPayload(await request.json().catch(() => null))
  if (!payload) {
    return errorResponse('invalid-comment-body', 'Invalid comment body.', 400)
  }
  const db = createDb()
  const access = await loadCommentAccess(db, user, params.id)
  if (!access) return errorResponse('not-found', 'Shareable not found.', 404)
  const result = await handleCommentMutation(db, access, user, payload, {
    waitUntil: (promise) => context.get(ctxContext).waitUntil(promise),
  })

  switch (result.kind) {
    case 'ok':
      return Response.json({ threads: result.threads })
    case 'invalid-body':
      return errorResponse('invalid-comment-body', 'Invalid comment body.', 400)
    case 'invalid-anchor':
      return errorResponse(
        'invalid-comment-anchor',
        'Invalid comment anchor.',
        400,
      )
    case 'invalid-thread':
      return errorResponse('not-found', 'Comment not found.', 404)
    case 'invalid-message':
      return errorResponse('not-found', 'Comment message not found.', 404)
    case 'closed-thread':
      return errorResponse('closed-thread', 'Comment thread is resolved.', 409)
    case 'forbidden':
      return errorResponse('forbidden', 'Forbidden.', 403)
    case 'commit-failed':
      return errorResponse('commit-failed', 'Failed to save comment.', 502)
    case 'not-found':
      return errorResponse('not-found', 'Shareable not found.', 404)
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

function handleCommentMutation(
  db: ReturnType<typeof createDb>,
  access: NonNullable<Awaited<ReturnType<typeof loadCommentAccess>>>,
  user: ReturnType<typeof requireUser>,
  payload: CommentPayload,
  options: Parameters<typeof createCommentThread>[5],
) {
  const mutationOptions = {
    ...options,
    ...(payload.clientMutationId
      ? { originMutationId: payload.clientMutationId, originUserId: user.id }
      : {}),
  }
  switch (payload.intent) {
    case 'create-thread':
      return createCommentThread(
        db,
        access,
        user,
        payload.body,
        payload.anchor,
        mutationOptions,
      )
    case 'reply':
      return replyToCommentThread(
        db,
        access,
        user,
        payload.threadId,
        payload.body,
        mutationOptions,
      )
    case 'resolve':
    case 'reopen':
      return changeComment(
        db,
        access,
        user,
        {
          kind: 'update',
          threadId: payload.threadId,
          resolved: payload.intent === 'resolve',
        },
        mutationOptions,
      )
    case 'update-message':
      return changeComment(
        db,
        access,
        user,
        { kind: 'update', messageId: payload.messageId, body: payload.body },
        mutationOptions,
      )
    case 'delete-message':
      return changeComment(
        db,
        access,
        user,
        { kind: 'delete', messageId: payload.messageId },
        mutationOptions,
      )
    case 'delete-thread':
      return changeComment(
        db,
        access,
        user,
        { kind: 'delete', threadId: payload.threadId },
        mutationOptions,
      )
    default: {
      const _exhaustive: never = payload
      return _exhaustive
    }
  }
}

type CommentPayload = (
  | {
      intent: 'create-thread'
      body: string
      anchor?: CommentAnchorPayload
    }
  | { intent: 'reply'; threadId: string; body: string }
  | { intent: 'resolve' | 'reopen'; threadId: string }
  | { intent: 'update-message'; messageId: string; body: string }
  | { intent: 'delete-message'; messageId: string }
  | { intent: 'delete-thread'; threadId: string }
) & { clientMutationId?: string }

interface CommentAnchorPayload {
  quotedText: string
  prefixText: string
  suffixText: string
  textStart: number
  textEnd: number
  cssPath: string | null
}

function parseCommentPayload(body: unknown): CommentPayload | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const raw = body as {
    intent?: unknown
    threadId?: unknown
    messageId?: unknown
    body?: unknown
    anchor?: unknown
    clientMutationId?: unknown
  }
  const clientMutationId = parseClientMutationId(raw.clientMutationId)
  if (raw.intent === 'create-thread' && typeof raw.body === 'string') {
    if (raw.body.length > MAX_COMMENT_BODY_LENGTH) return null
    const anchor = parseAnchor(raw.anchor)
    if (raw.anchor !== undefined && !anchor) return null
    return withClientMutationId(
      { intent: raw.intent, body: raw.body, ...(anchor ? { anchor } : {}) },
      clientMutationId,
    )
  }
  if (
    raw.intent === 'reply' &&
    typeof raw.threadId === 'string' &&
    typeof raw.body === 'string'
  ) {
    if (
      !validThreadId(raw.threadId) ||
      raw.body.length > MAX_COMMENT_BODY_LENGTH
    ) {
      return null
    }
    return withClientMutationId(
      { intent: raw.intent, threadId: raw.threadId, body: raw.body },
      clientMutationId,
    )
  }
  if (
    (raw.intent === 'resolve' || raw.intent === 'reopen') &&
    typeof raw.threadId === 'string'
  ) {
    if (!validThreadId(raw.threadId)) return null
    return withClientMutationId(
      { intent: raw.intent, threadId: raw.threadId },
      clientMutationId,
    )
  }
  if (
    raw.intent === 'update-message' &&
    typeof raw.messageId === 'string' &&
    typeof raw.body === 'string'
  ) {
    if (
      !validThreadId(raw.messageId) ||
      raw.body.length > MAX_COMMENT_BODY_LENGTH
    ) {
      return null
    }
    return withClientMutationId(
      { intent: raw.intent, messageId: raw.messageId, body: raw.body },
      clientMutationId,
    )
  }
  if (raw.intent === 'delete-message' && typeof raw.messageId === 'string') {
    if (!validThreadId(raw.messageId)) return null
    return withClientMutationId(
      { intent: raw.intent, messageId: raw.messageId },
      clientMutationId,
    )
  }
  if (raw.intent === 'delete-thread' && typeof raw.threadId === 'string') {
    if (!validThreadId(raw.threadId)) return null
    return withClientMutationId(
      { intent: raw.intent, threadId: raw.threadId },
      clientMutationId,
    )
  }
  return null
}

function withClientMutationId<
  T extends Omit<CommentPayload, 'clientMutationId'>,
>(
  payload: T,
  clientMutationId: string | undefined,
): T & { clientMutationId?: string } {
  return clientMutationId ? { ...payload, clientMutationId } : payload
}

function parseClientMutationId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value.length === 0 || value.length > 128) return undefined
  return value
}

function parseAnchor(value: unknown): CommentAnchorPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.quotedText !== 'string' ||
    typeof raw.prefixText !== 'string' ||
    typeof raw.suffixText !== 'string' ||
    typeof raw.textStart !== 'number' ||
    typeof raw.textEnd !== 'number' ||
    (raw.cssPath !== null && typeof raw.cssPath !== 'string')
  ) {
    return null
  }
  return {
    quotedText: raw.quotedText,
    prefixText: raw.prefixText,
    suffixText: raw.suffixText,
    textStart: raw.textStart,
    textEnd: raw.textEnd,
    cssPath: raw.cssPath,
  }
}

function validThreadId(value: string): boolean {
  return value.length > 0 && value.length <= 128
}
