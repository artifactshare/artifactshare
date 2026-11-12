import {
  acquireCommentRuntime,
  withCommentRuntime,
} from '~/routes/a.$id/+components/comment-runtime-browser'

export function hasPendingCommentMutation(id: string) {
  return withCommentRuntime(id, (lease) => lease.hasPending())
}

/** Synthetic writer for reconciliation fixtures; uses the production lifecycle. */
export function settleCommentRuntimeMutation(input: {
  shareableId: string
  clientMutationId?: string
  appliedThreads?: boolean
  threadId?: string
}) {
  const lease = acquireCommentRuntime(input.shareableId)
  try {
    lease
      .beginMutation(
        input.clientMutationId ?? 'synthetic-mutation',
        input.threadId,
      )
      .settle({
        appliedThreads: input.appliedThreads ?? false,
        threadId: input.threadId,
      })
  } finally {
    lease.release()
  }
}
