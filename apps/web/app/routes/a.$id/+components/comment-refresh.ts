const COMMENT_AUTH_RECHECK_DELAY_MS = 1_000

export type CommentRefreshResult = 'keep-connection' | 'close-connection'

export type CommentRefreshAttemptOutcome =
  | 'success'
  | 'auth-error'
  | 'transient-error'

type CommentRefreshDeferOutcome =
  | 'missing-response'
  | 'response-error'
  | 'body-missing'

type CommentRefreshWithAuthRecoveryOptions = {
  runAttempt: () => Promise<CommentRefreshAttemptOutcome>
  waitBeforeRetry: () => Promise<boolean>
}

type CommentRefreshScheduler = {
  request: () => Promise<CommentRefreshResult>
  cancelPending: () => void
}

export function shouldDeferCommentRefreshDuringMutation({
  hasPendingMutation,
  outcome,
}: {
  hasPendingMutation: boolean
  outcome: CommentRefreshDeferOutcome
}): boolean {
  switch (outcome) {
    case 'missing-response':
    case 'response-error':
    case 'body-missing':
      return hasPendingMutation
  }
}

export function createCommentRefreshScheduler(
  runOnce: () => Promise<CommentRefreshResult>,
): CommentRefreshScheduler {
  let loopPromise: Promise<CommentRefreshResult> | null = null
  let pendingRefresh = false

  return {
    request() {
      if (loopPromise) {
        pendingRefresh = true
        return loopPromise
      }

      let currentLoop: Promise<CommentRefreshResult>
      currentLoop = (async () => {
        try {
          do {
            pendingRefresh = false
            const result = await runOnce()
            if (result !== 'keep-connection') {
              pendingRefresh = false
              return result
            }
          } while (pendingRefresh)
          return 'keep-connection' as const
        } finally {
          loopPromise = null
        }
      })()
      loopPromise = currentLoop
      return currentLoop
    },
    cancelPending() {
      pendingRefresh = false
    },
  }
}

export async function runCommentRefreshWithAuthRecovery({
  runAttempt,
  waitBeforeRetry,
}: CommentRefreshWithAuthRecoveryOptions): Promise<CommentRefreshResult> {
  const firstAttempt = await runAttempt()
  if (firstAttempt === 'success') return 'keep-connection'
  if (firstAttempt !== 'auth-error') return 'keep-connection'

  const shouldRetry = await waitBeforeRetry()
  if (!shouldRetry) return 'keep-connection'

  const secondAttempt = await runAttempt()
  if (secondAttempt === 'auth-error') return 'close-connection'
  if (secondAttempt === 'success') return 'keep-connection'
  return 'keep-connection'
}

export function isCommentAuthErrorStatus(status: number): boolean {
  return status === 401 || status === 404
}

export function waitForCommentAuthRecheck(
  signal: AbortSignal,
  shouldContinue: () => boolean,
): Promise<boolean> {
  if (signal.aborted || !shouldContinue()) return Promise.resolve(false)
  return new Promise((resolve) => {
    const timeoutId = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(!signal.aborted && shouldContinue())
    }, COMMENT_AUTH_RECHECK_DELAY_MS)
    const onAbort = () => {
      globalThis.clearTimeout(timeoutId)
      resolve(false)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
