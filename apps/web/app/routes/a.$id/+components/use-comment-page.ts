import { useCallback, useEffect, useRef, useState } from 'react'
import type { CommentThreadView } from '~/lib/comments'
import { fetchJsonWithViewerTimeout } from '~/lib/viewer-network'
import {
  getCommentMutationEpoch,
  hasPendingCommentMutation,
} from './use-comment-mutations'
import type {
  ChangeCommentThreads,
  CommentPageRequest,
} from './comment-history'

export function useCommentPage(
  shareableId: string,
  threadId: string,
  onThreadsChange: ChangeCommentThreads,
) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>('idle')
  const active = useRef<AbortController | null>(null)
  useEffect(
    () => () => {
      active.current?.abort()
      active.current = null
    },
    [shareableId, threadId],
  )
  const load = useCallback(
    async (page: CommentPageRequest): Promise<boolean> => {
      if (active.current || hasPendingCommentMutation(shareableId)) return false
      const controller = new AbortController()
      active.current = controller
      const epoch = getCommentMutationEpoch(shareableId)
      setStatus('loading')
      let outcome: 'idle' | 'failed' = 'failed'
      const params = new URLSearchParams({ thread_id: threadId })
      if (page.through) params.set('through', page.through)
      if (page.before) params.set('before', page.before)
      if (page.aroundMessageId)
        params.set('around_message_id', page.aroundMessageId)
      if (page.limit) params.set('limit', String(page.limit))
      try {
        const result = await fetchJsonWithViewerTimeout<{
          threads: CommentThreadView[]
          page?: { through?: string }
        }>(
          `/api/shareables/${encodeURIComponent(shareableId)}/comments?${params}`,
          { signal: controller.signal },
          { requireJson: true },
        )
        if (controller.signal.aborted) return false
        if (
          !result.response.ok ||
          !result.body?.threads ||
          epoch !== getCommentMutationEpoch(shareableId)
        )
          throw new Error('Comment page needs retry')
        onThreadsChange(result.body.threads, {
          threadId,
          page:
            page.aroundMessageId && result.body.page?.through
              ? {
                  through: result.body.page.through,
                  limit: Math.max(
                    1,
                    (result.body.threads[0]?.messages.length ?? 1) - 1,
                  ),
                }
              : page,
        })
        outcome = 'idle'
        return true
      } catch {
        return false
      } finally {
        if (active.current === controller) {
          active.current = null
          setStatus(outcome)
        }
      }
    },
    [shareableId, threadId, onThreadsChange],
  )
  return { load, pending: status === 'loading', failed: status === 'failed' }
}
