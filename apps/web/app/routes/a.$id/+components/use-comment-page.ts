import { commentPageUrl } from '~/lib/comment-page'
import { useCallback, useEffect, useRef, useState, useReducer } from 'react'
import type { CommentThreadView } from '~/lib/comments'
import { fetchJsonWithViewerTimeout } from '~/lib/viewer-network'
import {
  COMMENT_MUTATION_SETTLED_EVENT,
  type CommentMutationSettledDetail,
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
  targetMessageId?: string,
) {
  const [status, setStatus] = useState<'idle' | 'loading' | 'failed'>('idle')
  const active = useRef<AbortController | null>(null)
  const activeTarget = useRef<string | undefined>(undefined)
  const attemptedTarget = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (activeTarget.current && activeTarget.current !== targetMessageId) {
      attemptedTarget.current = undefined
      active.current?.abort()
    }
  }, [targetMessageId])
  const [settled, notifySettled] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    const onSettled = (event: Event) => {
      if (
        (event as CustomEvent<CommentMutationSettledDetail>).detail
          .shareableId === shareableId
      )
        notifySettled()
    }
    window.addEventListener(COMMENT_MUTATION_SETTLED_EVENT, onSettled)
    return () =>
      window.removeEventListener(COMMENT_MUTATION_SETTLED_EVENT, onSettled)
  }, [shareableId])
  useEffect(
    () => () => {
      active.current?.abort()
      active.current = null
      attemptedTarget.current = undefined
    },
    [shareableId, threadId],
  )
  const load = useCallback(
    async (page: CommentPageRequest): Promise<boolean> => {
      if (active.current || hasPendingCommentMutation(shareableId)) return false
      const controller = new AbortController()
      active.current = controller
      activeTarget.current = page.aroundMessageId
      const epoch = getCommentMutationEpoch(shareableId)
      setStatus('loading')
      let outcome: 'idle' | 'failed' = 'failed'
      try {
        const result = await fetchJsonWithViewerTimeout<{
          threads: CommentThreadView[]
          page?: { through?: string }
        }>(
          commentPageUrl(shareableId, threadId, page),
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
          activeTarget.current = undefined
          setStatus(controller.signal.aborted ? 'idle' : outcome)
        }
      }
    },
    [shareableId, threadId, onThreadsChange],
  )
  useEffect(() => {
    if (!targetMessageId) {
      attemptedTarget.current = undefined
      return
    }
    if (
      attemptedTarget.current === targetMessageId ||
      active.current ||
      hasPendingCommentMutation(shareableId)
    )
      return
    attemptedTarget.current = targetMessageId
    void load({ aroundMessageId: targetMessageId, limit: 50 })
  }, [targetMessageId, shareableId, threadId, load, status, settled])
  return { load, pending: status === 'loading', failed: status === 'failed' }
}
