export const COMMENT_REPLY_PAGE_LIMIT = 50
export type CommentPageRequest = {
  through?: string
  before?: string
  limit?: number
  aroundMessageId?: string
}

export function validateCommentPageRequest(
  threadId: string | undefined,
  request: CommentPageRequest,
):
  | { kind: 'panel' }
  | { kind: 'thread'; threadId: string; request: CommentPageRequest }
  | { kind: 'invalid-page' } {
  const { before, through, aroundMessageId, limit } = request
  const selectors = [before, through, aroundMessageId].filter(
    (value) => value !== undefined,
  )
  if (threadId === undefined && selectors.length === 0 && limit === undefined)
    return { kind: 'panel' }
  if (
    !threadId ||
    threadId.length > 128 ||
    selectors.length > 1 ||
    (limit !== undefined &&
      (!Number.isInteger(limit) ||
        limit < 1 ||
        limit > COMMENT_REPLY_PAGE_LIMIT ||
        selectors.length === 0)) ||
    aroundMessageId === '' ||
    (aroundMessageId?.length ?? 0) > 128
  )
    return { kind: 'invalid-page' }
  return { kind: 'thread', threadId, request }
}

export function commentPageUrl(
  shareableId: string,
  threadId: string,
  request: CommentPageRequest = {},
) {
  const params = new URLSearchParams({ thread_id: threadId })
  if (request.through) params.set('through', request.through)
  if (request.before) params.set('before', request.before)
  if (request.aroundMessageId)
    params.set('around_message_id', request.aroundMessageId)
  if (request.limit) params.set('limit', String(request.limit))
  return `/api/shareables/${encodeURIComponent(shareableId)}/comments?${params}`
}
