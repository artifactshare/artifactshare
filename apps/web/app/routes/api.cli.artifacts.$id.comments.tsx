import { errorResponse } from '~/lib/api-errors'
import { MAX_COMMENT_BODY_LENGTH } from '~/lib/comments'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { ctxContext, getCliAuthority, requireUser } from '~/middleware/context'
import { isAgentReadableArtifact } from '~/services/agent-scope.server'
import { cliScopeDeniedResponse } from '~/lib/cli-agent-operations'
import {
  shareUrl,
  toAgentCommentThread,
} from '~/services/artifact-readback.server'
import {
  COMMENT_THREAD_LIST_LIMIT,
  changeComment,
  loadCommentAccess,
  loadCommentThreads,
  MAX_CONTEXT_TEXT_LENGTH,
  MAX_QUOTED_TEXT_LENGTH,
  postArtifactComment,
  type ChangeCommentInput,
  type CommentMutationResult,
  type PostArtifactCommentInput,
  type PostArtifactCommentResult,
} from '~/services/comments.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.artifacts.$id.comments'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const url = new URL(request.url)
  return await withDb(async (db) => {
    const authority = getCliAuthority(context)
    if (
      authority?.kind === 'agent' &&
      !(await isAgentReadableArtifact(db, user, authority, params.id))
    ) {
      return errorResponse('not-found', 'Artifact not found.', 404)
    }
    const access = await loadCommentAccess(db, user, params.id)
    if (!access) return errorResponse('not-found', 'Artifact not found.', 404)
    const threads = await loadCommentThreads(db, access, user)
    return Response.json({
      artifact_id: params.id,
      share_url: shareUrl(url.origin, params.id),
      comments: threads.map(toAgentCommentThread),
      // loadCommentThreads caps at the limit, so a full page can only signal
      // ">= limit"; exactly-limit reads as has_more (same as MCP get_artifact).
      has_more: threads.length >= COMMENT_THREAD_LIST_LIMIT,
    })
  })
}

export async function action({ context, params, request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const rawPayload = await request.json().catch(() => null)

  const user = requireUser(context)
  const url = new URL(request.url)
  return await withDb(async (db) => {
    const authority = getCliAuthority(context)
    if (authority?.kind === 'agent') {
      if (hasActionField(rawPayload)) return cliScopeDeniedResponse()
      if (!(await isAgentReadableArtifact(db, user, authority, params.id))) {
        return errorResponse('not-found', 'Artifact not found.', 404)
      }
    }
    const actionPayload = parseActionPayload(rawPayload)
    if (actionPayload) {
      const access = await loadCommentAccess(db, user, params.id)
      if (!access) return errorResponse('not-found', 'Artifact not found.', 404)
      const options = {
        waitUntil: (promise: Promise<unknown>) =>
          context.get(ctxContext).waitUntil(promise),
      }
      const result = await changeComment(
        db,
        access,
        user,
        commentChangeInput(actionPayload),
        options,
      )
      if (result.kind !== 'ok') return actionErrorResponse(result.kind)

      if ('deleted' in result) {
        return Response.json({
          artifact_id: params.id,
          share_url: shareUrl(url.origin, params.id),
          thread_id: result.threadId,
          deleted: true,
          thread_deleted: result.threadDeleted,
          ...(result.thread
            ? { thread: toAgentCommentThread(result.thread) }
            : {}),
        })
      }

      return Response.json({
        artifact_id: params.id,
        share_url: shareUrl(url.origin, params.id),
        thread_id: result.threadId,
        thread: toAgentCommentThread(result.thread),
      })
    }
    if (hasActionField(rawPayload)) {
      return errorResponse('invalid-comment', 'Invalid comment payload.', 400)
    }

    const payload = parsePayload(rawPayload)
    if (!payload) {
      return errorResponse('invalid-comment', 'Invalid comment payload.', 400)
    }
    const result = await postArtifactComment(db, user, params.id, payload, {
      agentProfileId:
        authority?.kind === 'agent' ? authority.agentProfileId : null,
      waitUntil: (promise) => context.get(ctxContext).waitUntil(promise),
    })
    if (result.kind !== 'ok') return postErrorResponse(result.kind)
    return Response.json({
      artifact_id: params.id,
      share_url: shareUrl(url.origin, params.id),
      thread_id: result.threadId,
      reply: result.reply,
      thread: toAgentCommentThread(result.thread),
    })
  })
}

type ActionPayload =
  | { action: 'edit'; messageId: string; body: string }
  | { action: 'resolve' | 'reopen'; threadId: string }
  | { action: 'delete'; threadId: string; messageId?: string }

function commentChangeInput(payload: ActionPayload): ChangeCommentInput {
  switch (payload.action) {
    case 'edit':
      return {
        kind: 'update' as const,
        messageId: payload.messageId,
        body: payload.body,
      }
    case 'resolve':
    case 'reopen':
      return {
        kind: 'update' as const,
        threadId: payload.threadId,
        resolved: payload.action === 'resolve',
      }
    case 'delete':
      if (payload.messageId) {
        return {
          kind: 'delete',
          threadId: payload.threadId,
          messageId: payload.messageId,
        }
      }
      return {
        kind: 'delete',
        threadId: payload.threadId,
      }
  }
}

function actionErrorResponse(
  kind: Exclude<CommentMutationResult['kind'], 'ok'>,
): Response {
  switch (kind) {
    case 'invalid-body':
      return errorResponse('invalid-comment', 'Invalid comment body.', 400)
    case 'invalid-anchor':
      return errorResponse('invalid-comment', 'Invalid comment anchor.', 400)
    case 'invalid-message':
      return errorResponse(
        'message-not-found',
        'Comment message not found.',
        404,
      )
    case 'invalid-thread':
      return errorResponse('thread-not-found', 'Comment thread not found.', 404)
    case 'closed-thread':
      return errorResponse(
        'thread-resolved',
        'Comment thread is resolved.',
        409,
      )
    case 'forbidden':
      return errorResponse('forbidden', 'Forbidden.', 403)
    case 'not-found':
      return errorResponse('not-found', 'Artifact not found.', 404)
    case 'commit-failed':
      return errorResponse('commit-failed', 'Failed to change comment.', 502)
  }
}

function postErrorResponse(
  kind: Exclude<PostArtifactCommentResult['kind'], 'ok'>,
): Response {
  switch (kind) {
    case 'quote-on-reply':
      return errorResponse(
        'quote-on-reply',
        'A quote can only anchor a new thread, not a reply.',
        400,
      )
    case 'quote-unsupported':
      return errorResponse(
        'quote-unsupported',
        'This artifact does not support quoted-text comments.',
        400,
      )
    case 'quote-not-found':
      return errorResponse(
        'quote-not-found',
        'The quoted text was not found in the artifact.',
        400,
      )
    case 'invalid-body':
      return errorResponse('invalid-comment', 'Invalid comment body.', 400)
    case 'invalid-anchor':
      return errorResponse('invalid-comment', 'Invalid comment anchor.', 400)
    case 'invalid-thread':
    case 'invalid-message':
      return errorResponse('thread-not-found', 'Comment thread not found.', 404)
    case 'closed-thread':
      return errorResponse(
        'thread-resolved',
        'Comment thread is resolved.',
        409,
      )
    case 'forbidden':
      return errorResponse('forbidden', 'Forbidden.', 403)
    case 'not-found':
      return errorResponse('not-found', 'Artifact not found.', 404)
    case 'commit-failed':
      return errorResponse('commit-failed', 'Failed to save comment.', 502)
  }
}

function hasActionField(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.hasOwn(value, 'action')
  )
}

function parseActionPayload(value: unknown): ActionPayload | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.action !== 'string') return null

  switch (raw.action) {
    case 'edit': {
      const messageId = optionalString(raw.message_id, 128)
      if (messageId === null || !messageId) return null
      if (
        typeof raw.body !== 'string' ||
        raw.body.length === 0 ||
        raw.body.length > MAX_COMMENT_BODY_LENGTH
      ) {
        return null
      }
      return { action: 'edit', messageId, body: raw.body }
    }
    case 'resolve':
    case 'reopen': {
      const threadId = optionalString(raw.thread_id, 128)
      if (threadId === null || !threadId) return null
      return { action: raw.action, threadId }
    }
    case 'delete': {
      const threadId = optionalString(raw.thread_id, 128)
      const messageId = optionalString(raw.message_id, 128)
      if (threadId === null || !threadId || messageId === null) return null
      return {
        action: 'delete',
        threadId,
        ...(messageId ? { messageId } : {}),
      }
    }
    default:
      return null
  }
}

function parsePayload(value: unknown): PostArtifactCommentInput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (typeof raw.body !== 'string') return null
  if (raw.body.length === 0 || raw.body.length > MAX_COMMENT_BODY_LENGTH) {
    return null
  }
  const replyTo = optionalString(raw.reply_to, 128)
  const quote = optionalString(raw.quote, MAX_QUOTED_TEXT_LENGTH)
  const quoteBefore = optionalString(raw.quote_before, MAX_CONTEXT_TEXT_LENGTH)
  const quoteAfter = optionalString(raw.quote_after, MAX_CONTEXT_TEXT_LENGTH)
  if (
    replyTo === null ||
    quote === null ||
    quoteBefore === null ||
    quoteAfter === null
  ) {
    return null
  }
  // Context options only steer a quote anchor; without a quote they signal a
  // malformed request rather than something to ignore (the CLI rejects the
  // same combination client-side).
  if (
    quote === undefined &&
    (quoteBefore !== undefined || quoteAfter !== undefined)
  ) {
    return null
  }
  const agent =
    typeof raw.agent === 'string' && raw.agent.trim()
      ? raw.agent.trim()
      : undefined
  if (agent !== undefined && agent.length > 30) return null
  return { body: raw.body, replyTo, quote, quoteBefore, quoteAfter, agent }
}

function optionalString(
  value: unknown,
  maxLength: number,
): string | undefined | null {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) return null
  if (value.length > maxLength) return null
  return value
}
