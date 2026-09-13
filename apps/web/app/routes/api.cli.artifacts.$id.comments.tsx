import {
  ArtifactIdParamsSchema,
  CommentActionResponseSchema,
  CommentDeleteResponseSchema,
  CommentPostResponseSchema,
  CommentRequestSchema,
  CommentsListResponseSchema,
  type CommentActionRequest,
  type CommentPostRequest,
} from '@artifactshare/contract'
import { errorResponse } from '~/lib/api-errors'
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
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Artifact not found.', 404)
  }
  const { id } = parsedParams.data
  const url = new URL(request.url)
  return await withDb(async (db) => {
    const authority = getCliAuthority(context)
    if (
      authority?.kind === 'agent' &&
      !(await isAgentReadableArtifact(db, user, authority, id))
    ) {
      return errorResponse('not-found', 'Artifact not found.', 404)
    }
    const access = await loadCommentAccess(db, user, id)
    if (!access) return errorResponse('not-found', 'Artifact not found.', 404)
    const threads = await loadCommentThreads(db, access, user)
    return Response.json(
      CommentsListResponseSchema.parse({
        artifact_id: id,
        share_url: shareUrl(url.origin, id, access.visibility),
        comments: threads.map(toAgentCommentThread),
        // loadCommentThreads caps at the limit, so a full page can only signal
        // ">= limit"; exactly-limit reads as has_more (same as MCP get_artifact).
        has_more: threads.length >= COMMENT_THREAD_LIST_LIMIT,
      }),
    )
  })
}

export async function action({ context, params, request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const rawPayload = await request.json().catch(() => null)
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Artifact not found.', 404)
  }
  const { id } = parsedParams.data

  const user = requireUser(context)
  const url = new URL(request.url)
  return await withDb(async (db) => {
    const authority = getCliAuthority(context)
    if (authority?.kind === 'agent') {
      if (hasActionField(rawPayload)) return cliScopeDeniedResponse()
      if (!(await isAgentReadableArtifact(db, user, authority, id))) {
        return errorResponse('not-found', 'Artifact not found.', 404)
      }
    }
    const parsedPayload = CommentRequestSchema.safeParse(rawPayload)
    if (hasActionField(rawPayload)) {
      if (
        !parsedPayload.success ||
        !isCommentActionRequest(parsedPayload.data)
      ) {
        return errorResponse('invalid-comment', 'Invalid comment payload.', 400)
      }
      const actionPayload = parsedPayload.data
      const access = await loadCommentAccess(db, user, id)
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
        return Response.json(
          CommentDeleteResponseSchema.parse({
            artifact_id: id,
            share_url: shareUrl(url.origin, id, access.visibility),
            thread_id: result.threadId,
            deleted: true,
            thread_deleted: result.threadDeleted,
            ...(result.thread
              ? { thread: toAgentCommentThread(result.thread) }
              : {}),
          }),
        )
      }

      return Response.json(
        CommentActionResponseSchema.parse({
          artifact_id: id,
          share_url: shareUrl(url.origin, id, access.visibility),
          thread_id: result.threadId,
          thread: toAgentCommentThread(result.thread),
        }),
      )
    }

    if (!parsedPayload.success || isCommentActionRequest(parsedPayload.data)) {
      return errorResponse('invalid-comment', 'Invalid comment payload.', 400)
    }
    const result = await postArtifactComment(
      db,
      user,
      id,
      commentPostInput(parsedPayload.data),
      {
        agentProfileId:
          authority?.kind === 'agent' ? authority.agentProfileId : null,
        waitUntil: (promise) => context.get(ctxContext).waitUntil(promise),
      },
    )
    if (result.kind !== 'ok') return postErrorResponse(result.kind)
    return Response.json(
      CommentPostResponseSchema.parse({
        artifact_id: id,
        share_url: shareUrl(url.origin, id, result.visibility),
        thread_id: result.threadId,
        reply: result.reply,
        thread: toAgentCommentThread(result.thread),
      }),
    )
  })
}

function commentChangeInput(payload: CommentActionRequest): ChangeCommentInput {
  switch (payload.action) {
    case 'edit':
      return {
        kind: 'update' as const,
        messageId: payload.message_id,
        body: payload.body,
      }
    case 'resolve':
    case 'reopen':
      return {
        kind: 'update' as const,
        threadId: payload.thread_id,
        resolved: payload.action === 'resolve',
      }
    case 'delete':
      if (payload.message_id) {
        return {
          kind: 'delete',
          threadId: payload.thread_id,
          messageId: payload.message_id,
        }
      }
      return {
        kind: 'delete',
        threadId: payload.thread_id,
      }
  }
}

function commentPostInput(
  payload: CommentPostRequest,
): PostArtifactCommentInput {
  return {
    body: payload.body,
    replyTo: payload.reply_to,
    quote: payload.quote,
    quoteBefore: payload.quote_before,
    quoteAfter: payload.quote_after,
    agent: payload.agent?.trim() || undefined,
  }
}

function isCommentActionRequest(
  payload: CommentActionRequest | CommentPostRequest,
): payload is CommentActionRequest {
  return (
    payload.action === 'edit' ||
    payload.action === 'resolve' ||
    payload.action === 'reopen' ||
    payload.action === 'delete'
  )
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
