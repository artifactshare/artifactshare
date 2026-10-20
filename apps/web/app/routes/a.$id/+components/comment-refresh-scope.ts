type CommentRefreshScope = 'all' | ReadonlySet<string>

/** Immutable snapshots keep a successful request from clearing newer dirtiness. */
export function createCommentRefreshScope() {
  let scope: CommentRefreshScope = new Set()
  let revision = 0
  return {
    mark(threadId?: string) {
      revision += 1
      if (!threadId) scope = 'all'
      else if (scope !== 'all') scope = new Set([...scope, threadId])
    },
    snapshot() {
      const capturedRevision = revision
      const captured = scope
      return {
        has: (threadId: string) => captured === 'all' || captured.has(threadId),
        complete() {
          if (revision === capturedRevision) scope = new Set()
        },
      }
    },
  }
}
