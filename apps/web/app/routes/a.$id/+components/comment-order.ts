import type { CommentThreadView } from '~/lib/comments'

export type NewCommentMessage = { messageId: string; threadId: string }

export function firstNewCommentThread(
  threads: ReadonlyArray<CommentThreadView>,
  pairs: ReadonlyArray<NewCommentMessage>,
): string | null {
  return (
    [...threads]
      .sort(compareCommentThreads)
      .find((thread) =>
        pairs.some(
          (pair) =>
            pair.threadId === thread.id &&
            thread.messages.some((message) => message.id === pair.messageId),
        ),
      )?.id ?? null
  )
}

export function compareCommentThreads(
  left: CommentThreadView,
  right: CommentThreadView,
): number {
  const rank = (thread: CommentThreadView) => {
    // A comment still being checked keeps the attached position, so the
    // list does not jump when the check finishes.
    if (
      thread.subject.kind === 'text' &&
      (thread.subject.state === 'attached' ||
        thread.subject.checking ||
        thread.subject.positionState === 'unchecked')
    ) {
      return 0
    }
    if (thread.subject.kind === 'artifact') return 1
    return 2
  }
  const rankDiff = rank(left) - rank(right)
  if (rankDiff !== 0) return rankDiff
  return right.messages.length - left.messages.length
}
