import { acquireCommentRuntime } from './comment-runtime-browser'
import { COMMENT_REPLY_PAGE_LIMIT, commentPageUrl } from '~/lib/comment-page'
import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  useCallback,
  useEffect,
  useRef,
  useState,
  useReducer,
} from 'react'
import type { CommentPageConsumerSnapshot } from './comment-session'
import type { CommentSession } from './comment-data-port'
import { useLatestRef } from '~/hooks/use-latest-ref'
import type { CommentThreadView } from '~/lib/comments'
import { fetchJsonWithViewerTimeout } from '~/lib/viewer-network'
import { hasPendingCommentMutation } from './use-comment-mutations'
import type {
  ChangeCommentThreads,
  CommentPageRequest,
} from './comment-history'

function useLegacyCommentPage(
  shareableId: string,
  threadId: string,
  onThreadsChange: ChangeCommentThreads,
  targetMessageId?: string,
  onTargetMissing?: (messageId: string) => void,
  enabled = true,
) {
  const [status, setStatus] = useState<
    | { kind: 'idle' | 'loading' }
    | { kind: 'failed'; request: CommentPageRequest }
  >({ kind: 'idle' })
  const queued = useRef<CommentPageRequest | null>(null)
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
    if (!enabled) return
    const runtime = acquireCommentRuntime(shareableId)
    const unsubscribe = runtime.subscribe(() => notifySettled())
    return () => {
      unsubscribe()
      runtime.release()
    }
  }, [shareableId, enabled])
  useEffect(
    () => () => {
      active.current?.abort()
      active.current = null
      queued.current = null
      attemptedTarget.current = undefined
    },
    [shareableId, threadId],
  )
  const load = useCallback(
    async (page: CommentPageRequest): Promise<boolean> => {
      if (!enabled || active.current) return false
      if (hasPendingCommentMutation(shareableId)) {
        queued.current = page
        setStatus({ kind: 'loading' })
        return false
      }
      queued.current = null
      const controller = new AbortController()
      active.current = controller
      activeTarget.current = page.aroundMessageId
      const readLease = acquireCommentRuntime(shareableId)
      const epoch = readLease.getEpoch(threadId)
      setStatus({ kind: 'loading' })
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
        const removed = (code: number) => code === 404 || code === 410
        const removeThread = () => {
          onThreadsChange([], { threadId, deletedThreadId: threadId })
          outcome = 'idle'
          return true
        }
        if (
          removed(result.response.status) &&
          page.aroundMessageId &&
          onTargetMissing
        ) {
          // A missing message and an inaccessible/deleted thread share a 404.
          // Advance unread navigation only after confirming the thread survives.
          const thread = await fetchJsonWithViewerTimeout<{
            threads: CommentThreadView[]
          }>(
            commentPageUrl(shareableId, threadId),
            { signal: controller.signal },
            { requireJson: true },
          )
          if (controller.signal.aborted) return false
          if (removed(thread.response.status)) return removeThread()
          if (
            thread.response.ok &&
            thread.body?.threads.some((item) => item.id === threadId)
          ) {
            onTargetMissing(page.aroundMessageId)
            if (epoch !== readLease.getEpoch(threadId))
              onThreadsChange([], { threadId, revalidate: true })
            outcome = 'idle'
            return true
          }
        }
        if (!page.aroundMessageId && removed(result.response.status))
          return removeThread()
        if (!result.response.ok || !result.body?.threads)
          throw new Error('Comment page needs retry')
        onThreadsChange(result.body.threads, {
          threadId,
          ...(epoch !== readLease.getEpoch(threadId)
            ? { revalidate: true }
            : {}),
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
        readLease.release()
        if (active.current === controller) {
          active.current = null
          activeTarget.current = undefined
          setStatus(
            controller.signal.aborted || outcome === 'idle'
              ? { kind: 'idle' }
              : { kind: 'failed', request: page },
          )
        }
      }
    },
    [shareableId, threadId, onThreadsChange, onTargetMissing, enabled],
  )
  useEffect(() => {
    if (
      enabled &&
      queued.current &&
      !active.current &&
      !hasPendingCommentMutation(shareableId)
    )
      void load(queued.current)
  }, [settled, load, shareableId, enabled])
  useEffect(() => {
    if (!enabled) return
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
    void load({
      aroundMessageId: targetMessageId,
      limit: COMMENT_REPLY_PAGE_LIMIT,
    })
  }, [targetMessageId, shareableId, threadId, load, status, settled, enabled])
  return {
    load,
    pending: status.kind === 'loading',
    failed: status.kind === 'failed',
    failedRequest: status.kind === 'failed' ? status.request : undefined,
  }
}

/** One provider covers panel and inline consumers; null preserves legacy transport. */
export const CommentPageSessionContext = createContext<CommentSession | null>(
  null,
)
const idlePage: CommentPageConsumerSnapshot = { pending: false, failed: false }
const subscribeIdle = () => () => {}
const getIdle = () => idlePage

export function useCommentPage(
  shareableId: string,
  threadId: string,
  onThreadsChange: ChangeCommentThreads,
  targetMessageId?: string,
  onTargetMissing?: (messageId: string) => void,
) {
  const session = useContext(CommentPageSessionContext)
  const legacy = useLegacyCommentPage(
    shareableId,
    threadId,
    onThreadsChange,
    targetMessageId,
    onTargetMissing,
    session === null,
  )
  const missingRef = useLatestRef(onTargetMissing)
  const [ready, notifyReady] = useReducer((value: number) => value + 1, 0)
  const hasMissingCallback = Boolean(onTargetMissing)
  const consumer = useMemo(
    () =>
      session?.createPageConsumer({
        threadId,
        onReady: notifyReady,
        onTargetMissing: hasMissingCallback
          ? (id) => missingRef.current?.(id)
          : undefined,
      }),
    [session, threadId, missingRef, hasMissingCallback],
  )
  const snapshot = useSyncExternalStore(
    consumer?.subscribe ?? subscribeIdle,
    consumer?.getSnapshot ?? getIdle,
    consumer?.getSnapshot ?? getIdle,
  )
  useEffect(() => consumer?.activate(), [consumer])
  useEffect(() => {
    consumer?.resume()
  }, [consumer, ready])
  useEffect(() => {
    consumer?.setTarget(targetMessageId)
  }, [consumer, targetMessageId])
  return consumer ? { ...snapshot, load: consumer.load } : legacy
}
