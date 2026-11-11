import type { CommentSyncAssignment } from '~/lib/comment-sync'
import type { CommentThreadView } from '~/lib/comments'
import type { AnchorResolutionMessage } from '~/lib/csp-reporter'
import type { CommentThreadPatch } from './comment-history'
import type { CommentRefreshResult } from './comment-refresh'
import type { createCommentSession } from './comment-session'

export type CommentSession = ReturnType<typeof createCommentSession>
export type RecoveryCapture = {
  isCurrent: () => boolean
  adopt: (rows: ReadonlyArray<CommentThreadView>) => boolean
}
export type CommentDataPort = {
  assignment: CommentSyncAssignment
  session: CommentSession | null
  attach: () => () => void
  subscribeSettlement: (listener: () => void) => () => void
  onPageAuthError: (listener: () => void) => () => void
  requestRefresh: () => Promise<CommentRefreshResult>
  abortRefresh: () => void
  markAllDirty: () => void
  invalidatePages: () => void
  hasPending: () => boolean
  applyMutation: (
    rows: ReadonlyArray<CommentThreadView>,
    patch?: CommentThreadPatch,
  ) => void
  applyAnchorResults: (results: AnchorResolutionMessage['results']) => void
  retryTarget: () => void
  ensureTarget: () => void
  remoteChanged: (message: {
    threadId?: string
    originMutationId?: string
    originUserId?: string
  }) => boolean
  captureRecovery: () => RecoveryCapture
  retainRecovery: (
    capture: RecoveryCapture,
    rows: ReadonlyArray<CommentThreadView>,
  ) => void
  clearRecovery: () => void
  hasStaleRecovery: () => boolean
  applyRecovery: () => boolean
}

/** Retained data belongs to the selected owner; authorization remains with socket. */
export function withRetainedRecovery(
  port: Omit<
    CommentDataPort,
    'retainRecovery' | 'clearRecovery' | 'hasStaleRecovery' | 'applyRecovery'
  >,
): CommentDataPort {
  let recovery: {
    capture: RecoveryCapture
    rows: ReadonlyArray<CommentThreadView>
  } | null = null
  return {
    ...port,
    retainRecovery(capture, rows) {
      recovery = { capture, rows }
    },
    clearRecovery() {
      recovery = null
    },
    hasStaleRecovery: () => recovery !== null && !recovery.capture.isCurrent(),
    applyRecovery() {
      const retained = recovery
      recovery = null
      return retained !== null && retained.capture.adopt(retained.rows)
    },
  }
}
