import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  useEffect,
  useReducer,
} from 'react'
import type { CommentSession } from './comment-session'
import { useLatestRef } from '~/hooks/use-latest-ref'

export const CommentPageSessionContext = createContext<CommentSession | null>(
  null,
)

export class MissingCommentPageSessionError extends Error {
  constructor() {
    super('Comment pages require a display Session')
  }
}
export function useCommentPage(
  threadId: string,
  targetMessageId?: string,
  onTargetMissing?: (messageId: string) => void,
) {
  const session = useContext(CommentPageSessionContext)
  if (!session) throw new MissingCommentPageSessionError()
  const missingRef = useLatestRef(onTargetMissing)
  const [ready, notifyReady] = useReducer((value: number) => value + 1, 0)
  const hasMissingCallback = Boolean(onTargetMissing)
  const consumer = useMemo(
    () =>
      session.createPageConsumer({
        threadId,
        onReady: notifyReady,
        onTargetMissing: hasMissingCallback
          ? (id) => missingRef.current?.(id)
          : undefined,
      }),
    [session, threadId, missingRef, hasMissingCallback],
  )
  const snapshot = useSyncExternalStore(
    consumer.subscribe,
    consumer.getSnapshot,
    consumer.getSnapshot,
  )
  useEffect(() => consumer.activate(), [consumer])
  useEffect(() => {
    consumer.resume()
  }, [consumer, ready])
  useEffect(() => {
    consumer.setTarget(targetMessageId)
  }, [consumer, targetMessageId])
  return { ...snapshot, load: consumer.load }
}
