import { toast } from 'sonner'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate, useRevalidator } from 'react-router'
import { HistoryPanel, VersionWidget, type VersionRow } from './history-panel'
import { DropCatcher } from './drop-catcher'
import { hasLocalFiles } from './drag-files'
import { ViewerChrome } from './viewer-chrome'
import { CommentPanel } from './comment-panel'
import { ViewerListPanel } from './viewer-list-panel'
import {
  createViewerShellState,
  viewerShellReducer,
  type ViewerListOpenedFrom,
} from './viewer-shell-state'
import { useViewerList } from '../+hooks/use-viewer-list'

export {
  createViewerShellState,
  viewerShellReducer,
  type ViewerListCloseReason,
  type ViewerListOpenedFrom,
} from './viewer-shell-state'
export {
  useViewerList,
  type ViewerListRowView,
  type ViewerListStatus,
} from '../+hooks/use-viewer-list'
import { SandboxFrame } from './sandbox-frame'
import { type TextSelectionMessage } from '~/lib/csp-reporter'
import { type CommentThreadView } from '~/lib/comments'
import { InlineCommentPopover } from './inline-comment-popover'
import { pendingAnchorKey } from './inline-comment-popover-utils'
import { TextSelectionCommentChip } from './text-selection-comment-chip'
import { TextSelectionCommentPopover } from './text-selection-comment-popover'
import { getActiveElement } from './viewer-dom'
import { type PendingTextAnchor } from './viewer-comment-types'
import {
  COMMENT_MUTATION_SETTLED_EVENT,
  hasPendingCommentMutation,
  hasPendingCommentMutationId,
  type CommentMutationSettledDetail,
} from './use-comment-mutations'
import {
  useReplaceVersion,
  type ReplaceVersionInput,
} from '../+hooks/use-replace-version'
import { useT } from '~/hooks/use-t'
import { useLatestRef } from '~/hooks/use-latest-ref'
import { displayTitle } from '~/lib/display-title'
import {
  artifactSupportsComments,
  type ArtifactType,
} from '~/lib/artifact-type'
import { linkNavigationModeFor } from '~/lib/viewer-navigation'
import { type UserInfo } from '~/lib/user'
import { filesFromDrop } from '~/lib/upload-drop-items'
import {
  artifactSupportsExport,
  defaultExportPath,
  downloadText,
  fetchExportSource,
  htmlDownloadFileName,
  markdownDownloadFileName,
  openPrintWindow,
  resolveExportHtml,
  resolveExportMarkdown,
  type ExportPrintLabels,
  type ExportSourceData,
  writePrintPdf,
} from './export-actions'
import {
  cfRayFrom,
  fetchJsonWithViewerTimeout,
  VIEWER_FETCH_TIMEOUT_MS,
  logViewerNetworkEvent,
  viewerFetchFailureReason,
} from '~/lib/viewer-network'
import { cn } from '~/lib/utils'
import { Link } from 'react-router'

export type ViewerShellArtifact = {
  id: string
  name: string
  derivedTitle: string | null
  titleOverride: string | null
  entrypointPath?: string | null
  canReplaceFile?: boolean
  canViewHistory?: boolean
  currentVersionId?: string | null
  displayedVersionId?: string
  displayedVersionOrdinal?: number
  isHistoricalVersion?: boolean
  versions?: ReadonlyArray<VersionRow>
  comments?: ReadonlyArray<CommentThreadView>
  revisitContext?: {
    entryCurrentVersionId: string
    version:
      | { kind: 'ordinal'; from: number; to: number }
      | { kind: 'fallback' }
      | null
    commentCount: number
  } | null
} & Parameters<typeof ViewerChrome>[0]['artifact']

const emptyCommentThreads: ReadonlyArray<CommentThreadView> = []
const emptyPresence: ReadonlyArray<ViewerPresence> = []
const LIVE_PING_INTERVAL_MS = 30_000
const LIVE_PONG_TIMEOUT_MS = 10_000
const COMMENT_AUTH_RECHECK_DELAY_MS = 1_000
const LATEST_VERSION_RECONCILE_COOLDOWN_MS = 30_000
const LATEST_VERSION_FALLBACK_INTERVAL_MS = 5 * 60_000
const COMMENT_MUTATION_ECHO_TTL_MS = 30_000
const COMMENT_MUTATION_ECHO_MAX_ENTRIES = 20

interface ViewerPresence {
  id: string
  name: string
  image: string | null
  initial: string
}

interface ViewerCommentState {
  artifactId: string
  currentVersionId: string | null
  threads: ReadonlyArray<CommentThreadView>
  presence: ReadonlyArray<ViewerPresence>
  panelOpen: boolean
  targetThreadId: string | null
  targetThreadScroll: 'center' | 'start'
  pendingTextAnchor: PendingTextAnchor | null
  pendingComposerOpen: boolean
  inlineThreadId: string | null
  inlineThreadRect: TextSelectionMessage['rect'] | null
}

type ViewerCommentAction =
  | {
      type: 'artifact-changed'
      artifactId: string
      currentVersionId: string | null
      threads: ReadonlyArray<CommentThreadView>
    }
  | {
      type: 'threads-replaced'
      threads: ReadonlyArray<CommentThreadView>
    }
  | {
      type: 'presence-replaced'
      presence: ReadonlyArray<ViewerPresence>
    }
  | { type: 'version-changed'; currentVersionId: string | null }
  | { type: 'panel-open-changed'; open: boolean }
  | {
      type: 'thread-targeted'
      threadId: string
      scroll?: ViewerCommentState['targetThreadScroll']
    }
  | { type: 'text-selection-started'; anchor: PendingTextAnchor }
  | { type: 'pending-composer-opened' }
  | {
      type: 'inline-thread-opened'
      threadId: string
      rect: TextSelectionMessage['rect']
    }
  | { type: 'inline-popover-closed' }
  | { type: 'pending-text-anchor-cleared' }

type CommentRefreshResult = 'keep-connection' | 'close-connection'

type CommentRefreshAttemptOutcome = 'success' | 'auth-error' | 'transient-error'

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

function fetchCommentThreads<T>(
  artifactId: string,
  signal: AbortSignal,
  options: { requireJson?: boolean } = {},
) {
  return fetchJsonWithViewerTimeout<T>(
    `/api/shareables/${encodeURIComponent(artifactId)}/comments`,
    { headers: { accept: 'application/json' }, signal },
    options,
  )
}

type LiveRecoveryCheckResult =
  | { outcome: 'authorized'; threads: ReadonlyArray<CommentThreadView> }
  | { outcome: 'denied' | 'indeterminate' }

export function classifyLiveRecoveryResponse(
  response: Response,
  body: unknown,
): LiveRecoveryCheckResult {
  if (isCommentAuthErrorStatus(response.status)) return { outcome: 'denied' }
  if (
    !response.ok ||
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    return { outcome: 'indeterminate' }
  }
  if (!Object.prototype.hasOwnProperty.call(body, 'threads')) {
    return { outcome: 'indeterminate' }
  }
  const threads = (body as { threads?: unknown }).threads
  return Array.isArray(threads)
    ? { outcome: 'authorized', threads: threads as CommentThreadView[] }
    : { outcome: 'indeterminate' }
}

type AppliedCommentMutationEchoes = Map<string, number>
type LatestVersionCheckKind = 'fallback' | 'reconcile'

export function rememberAppliedCommentMutationEcho(
  echoes: AppliedCommentMutationEchoes,
  clientMutationId: string,
  now = Date.now(),
): void {
  evictAppliedCommentMutationEchoes(echoes, now)
  echoes.set(clientMutationId, now + COMMENT_MUTATION_ECHO_TTL_MS)
  while (echoes.size > COMMENT_MUTATION_ECHO_MAX_ENTRIES) {
    const oldest = echoes.keys().next().value
    if (typeof oldest !== 'string') break
    echoes.delete(oldest)
  }
}

export function consumeAppliedCommentMutationEcho(
  echoes: AppliedCommentMutationEchoes,
  clientMutationId: string,
  now = Date.now(),
): boolean {
  evictAppliedCommentMutationEchoes(echoes, now)
  const expiresAt = echoes.get(clientMutationId)
  if (expiresAt === undefined) return false
  echoes.delete(clientMutationId)
  return expiresAt > now
}

function evictAppliedCommentMutationEchoes(
  echoes: AppliedCommentMutationEchoes,
  now: number,
): void {
  for (const [clientMutationId, expiresAt] of echoes) {
    if (expiresAt > now) continue
    echoes.delete(clientMutationId)
  }
}

export function shouldClearLatestVersionRetryOnLiveAvailable(
  retryKind: LatestVersionCheckKind | null,
): boolean {
  return retryKind === 'fallback'
}

export function shouldPromoteLatestVersionRetry(
  existingKind: LatestVersionCheckKind | null,
  requestedKind: LatestVersionCheckKind,
): boolean {
  return existingKind === 'fallback' && requestedKind === 'reconcile'
}

export function shouldRefreshAfterAppliedCommentMutation({
  hasDeferredRefresh,
  requiresReconcile,
}: {
  hasDeferredRefresh: boolean
  requiresReconcile: boolean
}): boolean {
  return hasDeferredRefresh || requiresReconcile
}

function isCommentAuthErrorStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 404
}

function waitForCommentAuthRecheck(
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

function createViewerCommentState(
  artifactId: string,
  currentVersionId: string | null,
  threads: ReadonlyArray<CommentThreadView>,
  targetThreadId: string | null,
): ViewerCommentState {
  return {
    artifactId,
    currentVersionId,
    threads,
    presence: emptyPresence,
    panelOpen: false,
    targetThreadId,
    targetThreadScroll: 'start',
    pendingTextAnchor: null,
    pendingComposerOpen: false,
    inlineThreadId: null,
    inlineThreadRect: null,
  }
}

function viewerCommentReducer(
  state: ViewerCommentState,
  action: ViewerCommentAction,
): ViewerCommentState {
  switch (action.type) {
    case 'artifact-changed':
      return createViewerCommentState(
        action.artifactId,
        action.currentVersionId,
        action.threads,
        null,
      )
    case 'threads-replaced': {
      const hasTargetThread = action.threads.some(
        (thread) => thread.id === state.targetThreadId,
      )
      const hasInlineThread = action.threads.some(
        (thread) => thread.id === state.inlineThreadId,
      )
      return {
        ...state,
        threads: action.threads,
        targetThreadId: hasTargetThread ? state.targetThreadId : null,
        targetThreadScroll: hasTargetThread
          ? state.targetThreadScroll
          : 'start',
        inlineThreadId: hasInlineThread ? state.inlineThreadId : null,
        inlineThreadRect: hasInlineThread ? state.inlineThreadRect : null,
      }
    }
    case 'presence-replaced':
      return { ...state, presence: action.presence }
    case 'version-changed':
      return {
        ...state,
        currentVersionId: action.currentVersionId,
        targetThreadId: null,
        targetThreadScroll: 'start',
        pendingTextAnchor: null,
        pendingComposerOpen: false,
        inlineThreadId: null,
        inlineThreadRect: null,
      }
    case 'panel-open-changed':
      return action.open
        ? {
            ...state,
            panelOpen: true,
            pendingTextAnchor: null,
            pendingComposerOpen: false,
            inlineThreadId: null,
            inlineThreadRect: null,
          }
        : {
            ...state,
            panelOpen: false,
            targetThreadId: null,
            targetThreadScroll: 'start',
            pendingTextAnchor: null,
            pendingComposerOpen: false,
            inlineThreadId: null,
            inlineThreadRect: null,
          }
    case 'thread-targeted':
      return {
        ...state,
        panelOpen: true,
        targetThreadId: action.threadId,
        targetThreadScroll: action.scroll ?? 'start',
        inlineThreadId: null,
        inlineThreadRect: null,
      }
    case 'text-selection-started':
      return {
        ...state,
        panelOpen: false,
        targetThreadId: null,
        targetThreadScroll: 'start',
        pendingTextAnchor: action.anchor,
        pendingComposerOpen: false,
        inlineThreadId: null,
        inlineThreadRect: null,
      }
    case 'pending-composer-opened':
      return state.pendingTextAnchor
        ? { ...state, pendingComposerOpen: true }
        : state
    case 'inline-thread-opened':
      return {
        ...state,
        pendingTextAnchor: null,
        pendingComposerOpen: false,
        inlineThreadId: action.threadId,
        inlineThreadRect: action.rect,
      }
    case 'inline-popover-closed':
      return {
        ...state,
        targetThreadId: null,
        targetThreadScroll: 'start',
        inlineThreadId: null,
        inlineThreadRect: null,
      }
    case 'pending-text-anchor-cleared':
      return { ...state, pendingTextAnchor: null, pendingComposerOpen: false }
    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}

export function useViewerComments({
  artifactId,
  currentUserId,
  currentVersionId,
  initialThreads,
  targetCommentId,
  liveEnabled,
  onViewCountChanged,
  onVersionChanged,
  onVersionReconcile,
  onLiveConnectionChanged,
  onPanelOpened,
}: {
  artifactId: string
  currentUserId: string | null
  currentVersionId: string | null
  initialThreads: ReadonlyArray<CommentThreadView>
  targetCommentId: string | null
  liveEnabled: boolean
  onViewCountChanged?: (viewCount: number) => void
  onVersionChanged?: (currentVersionId: string) => void
  onVersionReconcile?: () => void
  onLiveConnectionChanged?: (connected: boolean) => void
  onPanelOpened?: () => void
}) {
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const requestedFilterRef = useRef<'all' | undefined>(undefined)
  const artifactIdRef = useLatestRef(artifactId)
  const onViewCountChangedRef = useLatestRef(onViewCountChanged)
  const onVersionChangedRef = useLatestRef(onVersionChanged)
  const onVersionReconcileRef = useLatestRef(onVersionReconcile)
  const onLiveConnectionChangedRef = useLatestRef(onLiveConnectionChanged)
  const onPanelOpenedRef = useLatestRef(onPanelOpened)
  const [appliedCommentMutationEchoes] = useState<AppliedCommentMutationEchoes>(
    () => new Map(),
  )
  const deferredCommentRefreshDuringMutationRef = useRef(false)
  const fetchSeqRef = useRef(0)
  const fetchAbortRef = useRef<AbortController | null>(null)
  const [state, dispatchComment] = useReducer(viewerCommentReducer, null, () =>
    createViewerCommentState(
      artifactId,
      currentVersionId,
      initialThreads,
      targetCommentId,
    ),
  )
  const totalCount = state.threads.length
  const threadsRef = useLatestRef(state.threads)

  if (state.artifactId !== artifactId) {
    dispatchComment({
      type: 'artifact-changed',
      artifactId,
      currentVersionId,
      threads: initialThreads,
    })
  }

  if (
    state.artifactId === artifactId &&
    state.currentVersionId !== currentVersionId
  ) {
    dispatchComment({ type: 'version-changed', currentVersionId })
  }

  useEffect(() => {
    if (!targetCommentId) return
    returnFocusRef.current = null
    onPanelOpenedRef.current?.()
    dispatchComment({ type: 'thread-targeted', threadId: targetCommentId })
  }, [onPanelOpenedRef, targetCommentId])

  const openPanel = useCallback(
    (returnFocusTo?: HTMLElement | null, requestedFilter?: 'all') => {
      returnFocusRef.current = returnFocusTo ?? getActiveElement()
      requestedFilterRef.current = requestedFilter
      onPanelOpenedRef.current?.()
      dispatchComment({ type: 'panel-open-changed', open: true })
    },
    [onPanelOpenedRef],
  )

  const replaceThreads = useCallback(
    (threads: ReadonlyArray<CommentThreadView>) => {
      dispatchComment({ type: 'threads-replaced', threads })
    },
    [],
  )
  const isCurrentArtifactId = useCallback(
    (requestArtifactId: string) => artifactIdRef.current === requestArtifactId,
    [artifactIdRef],
  )

  const changePanelOpen = useCallback(
    (open: boolean) => {
      if (!open) requestedFilterRef.current = undefined
      if (open) onPanelOpenedRef.current?.()
      dispatchComment({ type: 'panel-open-changed', open })
    },
    [onPanelOpenedRef],
  )

  const targetThread = useCallback(
    (
      threadId: string,
      options?: { scroll?: ViewerCommentState['targetThreadScroll'] },
    ) => {
      onPanelOpenedRef.current?.()
      dispatchComment({
        type: 'thread-targeted',
        threadId,
        scroll: options?.scroll,
      })
    },
    [onPanelOpenedRef],
  )

  const startTextSelection = useCallback((anchor: PendingTextAnchor) => {
    returnFocusRef.current = null
    dispatchComment({ type: 'text-selection-started', anchor })
  }, [])

  const openPendingComposer = useCallback(() => {
    dispatchComment({ type: 'pending-composer-opened' })
  }, [])

  const openInlineThread = useCallback(
    (threadId: string, rect: TextSelectionMessage['rect']) => {
      dispatchComment({ type: 'inline-thread-opened', threadId, rect })
    },
    [],
  )

  const closeInlinePopover = useCallback(() => {
    dispatchComment({ type: 'inline-popover-closed' })
  }, [])

  const clearPendingTextAnchor = useCallback(() => {
    dispatchComment({ type: 'pending-text-anchor-cleared' })
  }, [])

  const replaceThreadsIfChanged = useCallback(
    (threads: ReadonlyArray<CommentThreadView>) => {
      if (JSON.stringify(threadsRef.current) === JSON.stringify(threads)) return
      dispatchComment({ type: 'threads-replaced', threads })
    },
    [threadsRef],
  )

  const abortLatestThreadFetch = useEffectEvent(() => {
    fetchSeqRef.current += 1
    fetchScheduler.cancelPending()
    fetchAbortRef.current?.abort()
    fetchAbortRef.current = null
  })

  const fetchLatestThreadsOnce = useCallback(async () => {
    const requestArtifactId = artifactId
    const seq = fetchSeqRef.current + 1
    fetchSeqRef.current = seq
    fetchAbortRef.current?.abort()
    const controller = new AbortController()
    fetchAbortRef.current = controller

    const fetchThreads = async (): Promise<CommentRefreshAttemptOutcome> => {
      const deferIfPending = (
        outcome: Parameters<
          typeof shouldDeferCommentRefreshDuringMutation
        >[0]['outcome'],
      ) => {
        if (
          shouldDeferCommentRefreshDuringMutation({
            hasPendingMutation: hasPendingCommentMutation(requestArtifactId),
            outcome,
          })
        ) {
          deferredCommentRefreshDuringMutationRef.current = true
        }
      }
      const result = await fetchCommentThreads<{
        threads?: ReadonlyArray<CommentThreadView>
      }>(requestArtifactId, controller.signal).catch((error: unknown) => {
        if (seq !== fetchSeqRef.current) return null
        logViewerNetworkEvent({
          channel: 'fetch',
          purpose: 'comments',
          state: 'failed',
          reason: viewerFetchFailureReason(error),
        })
        return null
      })
      if (seq !== fetchSeqRef.current) return 'transient-error'
      const response = result?.response
      if (!response) {
        deferIfPending('missing-response')
        return 'transient-error'
      }
      if (!response.ok) {
        logViewerNetworkEvent({
          channel: 'fetch',
          purpose: 'comments',
          state: 'response-error',
          status: response.status,
          cfRay: cfRayFrom(response),
        })
      }
      if (!isCurrentArtifactId(requestArtifactId)) {
        deferIfPending('response-error')
        return 'transient-error'
      }
      if (isCommentAuthErrorStatus(response.status)) return 'auth-error'
      if (!response.ok) {
        deferIfPending('response-error')
        return 'transient-error'
      }
      if (hasPendingCommentMutation(requestArtifactId)) {
        deferredCommentRefreshDuringMutationRef.current = true
        return 'transient-error'
      }
      const body = result?.body ?? null
      if (!body) {
        deferIfPending('body-missing')
        return 'transient-error'
      }
      if (
        seq !== fetchSeqRef.current ||
        !isCurrentArtifactId(requestArtifactId) ||
        hasPendingCommentMutation(requestArtifactId)
      ) {
        deferIfPending('body-missing')
        return 'transient-error'
      }
      if (body.threads) replaceThreadsIfChanged(body.threads)
      return 'success'
    }

    const waitBeforeRetry = () =>
      waitForCommentAuthRecheck(controller.signal, () => {
        if (seq !== fetchSeqRef.current) return false
        return isCurrentArtifactId(requestArtifactId)
      })

    try {
      return await runCommentRefreshWithAuthRecovery({
        runAttempt: fetchThreads,
        waitBeforeRetry,
      })
    } finally {
      if (fetchAbortRef.current === controller) fetchAbortRef.current = null
    }
  }, [artifactId, isCurrentArtifactId, replaceThreadsIfChanged])

  const fetchLatestThreadsOnceRef = useLatestRef(fetchLatestThreadsOnce)
  const [fetchScheduler] = useState(() =>
    createCommentRefreshScheduler(() => fetchLatestThreadsOnceRef.current()),
  )

  const fetchLatestThreads = useCallback(() => {
    return fetchScheduler.request()
  }, [fetchScheduler])

  useEffect(() => {
    return () => {
      abortLatestThreadFetch()
    }
  }, [artifactId])

  // The socket lifecycle keeps authorization recovery independent from the
  // ordinary comments refresh scheduler.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (!liveEnabled) {
      onLiveConnectionChangedRef.current?.(false)
      return () => undefined
    }

    type ConnectionKind = 'ordinary' | 'renewal' | 'bounded'
    type RecoveryCheckCompletion =
      | {
          outcome: 'authorized'
          threads: ReadonlyArray<CommentThreadView>
          invalidated: boolean
        }
      | { outcome: 'denied' | 'indeterminate' | 'cancelled' }
    const ORDINARY_CHECK_AFTER_MS = 60_000
    const ORDINARY_STOP_AFTER_MS = 120_000
    const EXPIRY_CODE = 4401
    const EXPIRY_REASON = 'live-authorization-expired'

    let disposed = false
    let socket: WebSocket | null = null
    let retryTimer: number | null = null
    let preOpenTimer: number | null = null
    let stableTimer: number | null = null
    let pingTimer: number | null = null
    let pongTimer: number | null = null
    let reconnectAttempt = 0
    let reconnectStopped = false
    let ordinaryStartedAt: number | null = null
    let ordinaryCheckUsed = false
    let ordinaryIndeterminate = false
    let renewalActive = false
    let renewalAttempts = 0
    let boundedAttempts = 0
    let hiddenInterrupted = false
    let recoveryThreads: {
      threads: ReadonlyArray<CommentThreadView>
      invalidated: boolean
    } | null = null
    let recoveryController: AbortController | null = null
    let recoveryPromise: Promise<RecoveryCheckCompletion> | null = null
    let mutationEpoch = 0
    let recoverySequence = 0

    const clearRetryTimer = () => {
      if (retryTimer === null) return
      window.clearTimeout(retryTimer)
      retryTimer = null
    }
    const clearPreOpenTimer = () => {
      if (preOpenTimer === null) return
      window.clearTimeout(preOpenTimer)
      preOpenTimer = null
    }
    const clearStableTimer = () => {
      if (stableTimer === null) return
      window.clearTimeout(stableTimer)
      stableTimer = null
    }
    const clearPingTimer = () => {
      if (pingTimer === null) return
      window.clearInterval(pingTimer)
      pingTimer = null
    }
    const clearPongTimer = () => {
      if (pongTimer === null) return
      window.clearTimeout(pongTimer)
      pongTimer = null
    }
    const clearHeartbeat = () => {
      clearPingTimer()
      clearPongTimer()
    }
    const clearDisplay = () => {
      onLiveConnectionChangedRef.current?.(false)
      dispatchComment({ type: 'presence-replaced', presence: emptyPresence })
    }
    const releaseSocket = (close = false) => {
      const current = socket
      socket = null
      clearPreOpenTimer()
      clearStableTimer()
      clearHeartbeat()
      if (close) {
        try {
          current?.close()
        } catch {
          // The released socket can no longer affect this lifecycle.
        }
      }
    }
    const cancelRecoveryCheck = () => {
      recoverySequence += 1
      recoveryController?.abort()
      recoveryController = null
      recoveryPromise = null
    }
    const stopRecovery = () => {
      reconnectStopped = true
      clearRetryTimer()
      releaseSocket(true)
      cancelRecoveryCheck()
      renewalActive = false
      hiddenInterrupted = false
      clearDisplay()
    }
    const requestCommentRefresh = (ownerSocket: WebSocket | null) => {
      void fetchLatestThreads().then((result) => {
        if (
          result !== 'close-connection' ||
          disposed ||
          document.visibilityState === 'hidden' ||
          ownerSocket === null ||
          socket !== ownerSocket
        ) {
          return
        }
        stopRecovery()
      })
    }

    const runRecoveryCheck = (
      absoluteDeadlineMs?: number,
    ): Promise<RecoveryCheckCompletion> => {
      if (recoveryPromise) return recoveryPromise
      const controller = new AbortController()
      const checkMutationEpoch = mutationEpoch
      const sequence = recoverySequence + 1
      recoverySequence = sequence
      recoveryController = controller
      let boundaryTimer: number | null = null
      if (absoluteDeadlineMs !== undefined) {
        boundaryTimer = window.setTimeout(
          () => controller.abort(),
          Math.max(0, absoluteDeadlineMs - Date.now()),
        )
      }
      const currentPromise = (async (): Promise<RecoveryCheckCompletion> => {
        let completion: LiveRecoveryCheckResult
        try {
          const result = await fetchCommentThreads<unknown>(
            artifactId,
            controller.signal,
            { requireJson: true },
          )
          completion = classifyLiveRecoveryResponse(
            result.response,
            result.body,
          )
        } catch {
          completion = { outcome: 'indeterminate' }
        } finally {
          if (boundaryTimer !== null) window.clearTimeout(boundaryTimer)
          if (recoveryController === controller) {
            recoveryController = null
            recoveryPromise = null
          }
        }
        if (
          disposed ||
          sequence !== recoverySequence ||
          !isCurrentArtifactId(artifactId)
        ) {
          return { outcome: 'cancelled' }
        }
        // A same-sequence abort is the ordinary deadline, not supersession.
        if (controller.signal.aborted) return { outcome: 'indeterminate' }
        return completion.outcome === 'authorized'
          ? { ...completion, invalidated: checkMutationEpoch !== mutationEpoch }
          : completion
      })()
      recoveryPromise = currentPromise
      return currentPromise
    }

    const applyRecoveryThreads = () => {
      const snapshot = recoveryThreads
      recoveryThreads = null
      if (!snapshot || snapshot.invalidated) return false
      abortLatestThreadFetch()
      const { threads } = snapshot
      if (hasPendingCommentMutation(artifactId)) {
        deferredCommentRefreshDuringMutationRef.current = true
      } else {
        replaceThreadsIfChanged(threads)
      }
      return true
    }

    const sendPing = (currentSocket: WebSocket) => {
      if (
        socket !== currentSocket ||
        currentSocket.readyState !== WebSocket.OPEN
      ) {
        return
      }
      clearPongTimer()
      try {
        currentSocket.send('ping')
      } catch {
        logViewerNetworkEvent({
          channel: 'websocket',
          state: 'ping-send-failed',
          shareableId: artifactId,
        })
        currentSocket.close()
        return
      }
      pongTimer = window.setTimeout(() => {
        if (socket !== currentSocket) return
        logViewerNetworkEvent({
          channel: 'websocket',
          state: 'heartbeat-timeout',
          shareableId: artifactId,
        })
        currentSocket.close()
      }, LIVE_PONG_TIMEOUT_MS)
    }

    let startSocket: (kind: ConnectionKind) => void

    const scheduleBoundedAttempt = (
      kind: 'renewal' | 'bounded',
      delay: number,
    ) => {
      const attempt =
        kind === 'renewal' ? renewalAttempts + 1 : boundedAttempts + 1
      logViewerNetworkEvent({
        channel: 'websocket',
        state: 'reconnect-scheduled',
        shareableId: artifactId,
        attempt,
        delay,
      })
      clearRetryTimer()
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        if (
          disposed ||
          document.visibilityState === 'hidden' ||
          reconnectStopped ||
          socket
        ) {
          return
        }
        startSocket(kind)
      }, delay)
    }

    const finishRenewalFailure = async () => {
      if (renewalAttempts === 1) {
        const result = await runRecoveryCheck()
        if (result.outcome === 'cancelled') return
        if (
          disposed ||
          !renewalActive ||
          document.visibilityState === 'hidden'
        ) {
          return
        }
        if (result.outcome !== 'authorized') {
          stopRecovery()
          return
        }
        recoveryThreads = result
        scheduleBoundedAttempt('renewal', 2_000)
        return
      }
      if (renewalAttempts === 2) {
        scheduleBoundedAttempt('renewal', 4_000)
        return
      }
      stopRecovery()
    }

    const ordinaryBoundary = () =>
      ordinaryStartedAt === null
        ? null
        : ordinaryStartedAt + ORDINARY_STOP_AFTER_MS

    const scheduleOrdinaryRetry = () => {
      if (
        disposed ||
        reconnectStopped ||
        document.visibilityState === 'hidden'
      ) {
        return
      }
      const boundary = ordinaryBoundary()
      if (
        ordinaryIndeterminate &&
        boundary !== null &&
        Date.now() >= boundary
      ) {
        stopRecovery()
        return
      }
      let delay = Math.min(1000 * 2 ** reconnectAttempt, 30_000)
      reconnectAttempt += 1
      if (ordinaryIndeterminate && boundary !== null) {
        delay = Math.min(delay, Math.max(0, boundary - Date.now()))
      }
      logViewerNetworkEvent({
        channel: 'websocket',
        state: 'reconnect-scheduled',
        shareableId: artifactId,
        attempt: reconnectAttempt,
        delay,
      })
      clearRetryTimer()
      retryTimer = window.setTimeout(() => {
        retryTimer = null
        if (
          disposed ||
          reconnectStopped ||
          document.visibilityState === 'hidden' ||
          socket
        ) {
          return
        }
        const currentBoundary = ordinaryBoundary()
        if (
          ordinaryIndeterminate &&
          currentBoundary !== null &&
          Date.now() >= currentBoundary
        ) {
          stopRecovery()
          return
        }
        if (
          ordinaryStartedAt !== null &&
          Date.now() - ordinaryStartedAt >= ORDINARY_CHECK_AFTER_MS &&
          !ordinaryCheckUsed
        ) {
          ordinaryCheckUsed = true
          const checkBoundary = ordinaryStartedAt + ORDINARY_STOP_AFTER_MS
          void runRecoveryCheck(checkBoundary).then((result) => {
            if (result.outcome === 'cancelled') return
            if (
              disposed ||
              reconnectStopped ||
              document.visibilityState === 'hidden' ||
              ordinaryStartedAt === null
            ) {
              return
            }
            if (result.outcome === 'denied') {
              stopRecovery()
              return
            }
            if (result.outcome === 'authorized') {
              recoveryThreads = result
              boundedAttempts = 0
              startSocket('bounded')
              return
            }
            ordinaryIndeterminate = true
            scheduleOrdinaryRetry()
          })
          return
        }
        startSocket('ordinary')
      }, delay)
    }

    const handlePreOpenFailure = (kind: ConnectionKind) => {
      if (
        disposed ||
        reconnectStopped ||
        document.visibilityState === 'hidden'
      ) {
        return
      }
      if (kind === 'renewal') {
        void finishRenewalFailure()
        return
      }
      if (kind === 'bounded') {
        if (boundedAttempts === 1) {
          scheduleBoundedAttempt('bounded', 2_000)
        } else if (boundedAttempts === 2) {
          scheduleBoundedAttempt('bounded', 4_000)
        } else {
          stopRecovery()
        }
        return
      }
      ordinaryStartedAt ??= Date.now()
      scheduleOrdinaryRetry()
    }

    startSocket = (kind) => {
      if (
        disposed ||
        reconnectStopped ||
        document.visibilityState === 'hidden' ||
        socket
      ) {
        return
      }
      if (
        (kind === 'renewal' && renewalAttempts >= 3) ||
        (kind === 'bounded' && boundedAttempts >= 3)
      ) {
        stopRecovery()
        return
      }
      if (kind === 'renewal') renewalAttempts += 1
      if (kind === 'bounded') boundedAttempts += 1
      const boundary = ordinaryBoundary()
      if (
        kind === 'ordinary' &&
        ordinaryIndeterminate &&
        boundary !== null &&
        Date.now() >= boundary
      ) {
        stopRecovery()
        return
      }

      const url = new URL(
        `/api/shareables/${encodeURIComponent(artifactId)}/live`,
        window.location.href,
      )
      url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'

      let currentSocket: WebSocket
      try {
        currentSocket = new WebSocket(url)
      } catch {
        handlePreOpenFailure(kind)
        return
      }
      socket = currentSocket
      let opened = false
      let settled = false

      const failBeforeOpen = () => {
        if (socket !== currentSocket || settled) return
        settled = true
        releaseSocket(true)
        handlePreOpenFailure(kind)
      }

      preOpenTimer = window.setTimeout(
        failBeforeOpen,
        kind === 'ordinary' && ordinaryIndeterminate && boundary !== null
          ? Math.min(
              VIEWER_FETCH_TIMEOUT_MS,
              Math.max(0, boundary - Date.now()),
            )
          : VIEWER_FETCH_TIMEOUT_MS,
      )

      currentSocket.addEventListener('open', () => {
        if (socket !== currentSocket || settled) return
        clearPreOpenTimer()
        const stopBoundary = ordinaryBoundary()
        if (
          kind === 'ordinary' &&
          ordinaryIndeterminate &&
          stopBoundary !== null &&
          Date.now() >= stopBoundary
        ) {
          settled = true
          releaseSocket(true)
          stopRecovery()
          return
        }
        opened = true
        ordinaryStartedAt = null
        ordinaryCheckUsed = false
        ordinaryIndeterminate = false
        renewalActive = false
        // An open completes the episode; hiding pending work preserves these.
        renewalAttempts = 0
        boundedAttempts = 0
        reconnectStopped = false
        hiddenInterrupted = false
        onLiveConnectionChangedRef.current?.(true)
        logViewerNetworkEvent({
          channel: 'websocket',
          state: 'open',
          shareableId: artifactId,
        })
        clearStableTimer()
        stableTimer = window.setTimeout(() => {
          reconnectAttempt = 0
          stableTimer = null
        }, 30_000)
        sendPing(currentSocket)
        pingTimer = window.setInterval(
          () => sendPing(currentSocket),
          LIVE_PING_INTERVAL_MS,
        )
        onVersionReconcileRef.current?.()

        const reusedRecovery = applyRecoveryThreads()
        if (!reusedRecovery) {
          abortLatestThreadFetch()
          requestCommentRefresh(currentSocket)
        }
      })

      currentSocket.addEventListener('message', (event) => {
        if (socket !== currentSocket) return
        const message = parseLiveMessage(event.data)
        if (!message) return
        if (message.type === 'pong') {
          clearPongTimer()
        } else if (message.type === 'presence') {
          dispatchComment({
            type: 'presence-replaced',
            presence: message.users,
          })
        } else if (message.type === 'comments-changed') {
          if (
            message.originMutationId &&
            message.originUserId === currentUserId &&
            (hasPendingCommentMutationId(
              artifactId,
              message.originMutationId,
            ) ||
              consumeAppliedCommentMutationEcho(
                appliedCommentMutationEchoes,
                message.originMutationId,
              ))
          ) {
            return
          }
          requestCommentRefresh(currentSocket)
        } else if (message.type === 'view-count-changed') {
          onViewCountChangedRef.current?.(message.viewCount)
        } else if (message.type === 'version-changed') {
          onVersionChangedRef.current?.(message.currentVersionId)
        }
      })

      currentSocket.addEventListener('close', (event) => {
        if (socket !== currentSocket || settled) return
        settled = true
        releaseSocket()
        const recognizedExpiry =
          event.code === EXPIRY_CODE && event.reason === EXPIRY_REASON
        logViewerNetworkEvent({
          channel: 'websocket',
          state: 'close',
          shareableId: artifactId,
          code: event.code,
          clean: event.wasClean,
          opened,
        })
        if (opened && recognizedExpiry) {
          renewalActive = true
          renewalAttempts = 0
          recoveryThreads = null
          clearRetryTimer()
          abortLatestThreadFetch()
          startSocket('renewal')
          return
        }
        if (opened) {
          clearDisplay()
          if (
            !disposed &&
            !reconnectStopped &&
            document.visibilityState !== 'hidden'
          ) {
            scheduleOrdinaryRetry()
          }
          return
        }
        handlePreOpenFailure(kind)
      })

      currentSocket.addEventListener('error', () => {
        if (socket !== currentSocket || settled) return
        logViewerNetworkEvent({
          channel: 'websocket',
          state: 'error',
          shareableId: artifactId,
          opened,
        })
        try {
          currentSocket.close()
        } catch {
          if (!opened) failBeforeOpen()
        }
      })
    }

    const explicitRecovery = () => {
      if (
        disposed ||
        document.visibilityState === 'hidden' ||
        socket ||
        retryTimer !== null
      ) {
        return
      }
      void runRecoveryCheck().then((result) => {
        if (result.outcome === 'cancelled') return
        if (disposed || document.visibilityState === 'hidden') {
          return
        }
        if (socket || result.outcome !== 'authorized') {
          if (result.outcome !== 'authorized') stopRecovery()
          return
        }
        recoveryThreads = result
        reconnectStopped = false
        if (!hiddenInterrupted) boundedAttempts = 0
        startSocket(renewalActive ? 'renewal' : 'bounded')
      })
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        if (!reconnectStopped) hiddenInterrupted = true
        clearRetryTimer()
        cancelRecoveryCheck()
        abortLatestThreadFetch()
        releaseSocket(true)
        clearDisplay()
        return
      }
      if (!socket) explicitRecovery()
    }

    const onMutationSettled = (event: Event) => {
      const detail = (
        event as CustomEvent<Partial<CommentMutationSettledDetail>>
      ).detail
      if (detail?.shareableId !== artifactId) return
      // Older ordinary responses must not overwrite mutation-provided threads,
      // even when settlement needs no replacement refresh.
      abortLatestThreadFetch()
      // A settled mutation makes in-flight and captured recovery data stale. Keep its
      // authorization, but reconcile once on open instead of applying it.
      mutationEpoch += 1
      if (recoveryThreads) recoveryThreads.invalidated = true
      if (reconnectStopped && !socket) {
        explicitRecovery()
        return
      }
      if (
        detail.appliedThreads === true &&
        typeof detail.clientMutationId === 'string' &&
        detail.clientMutationId.length > 0
      ) {
        rememberAppliedCommentMutationEcho(
          appliedCommentMutationEchoes,
          detail.clientMutationId,
        )
        if (recoveryPromise || recoveryThreads?.invalidated) return
        if (
          !shouldRefreshAfterAppliedCommentMutation({
            hasDeferredRefresh: deferredCommentRefreshDuringMutationRef.current,
            requiresReconcile: detail.requiresReconcile === true,
          })
        ) {
          return
        }
        deferredCommentRefreshDuringMutationRef.current = false
        requestCommentRefresh(socket)
        return
      }
      if (recoveryPromise || recoveryThreads?.invalidated) return
      if (hasPendingCommentMutation(artifactId)) return
      deferredCommentRefreshDuringMutationRef.current = false
      requestCommentRefresh(socket)
    }

    startSocket('ordinary')
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener(COMMENT_MUTATION_SETTLED_EVENT, onMutationSettled)
    return () => {
      disposed = true
      clearRetryTimer()
      clearStableTimer()
      clearHeartbeat()
      cancelRecoveryCheck()
      abortLatestThreadFetch()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener(
        COMMENT_MUTATION_SETTLED_EVENT,
        onMutationSettled,
      )
      releaseSocket(true)
      clearDisplay()
    }
  }, [
    artifactId,
    appliedCommentMutationEchoes,
    currentUserId,
    fetchLatestThreads,
    isCurrentArtifactId,
    liveEnabled,
    onLiveConnectionChangedRef,
    onVersionChangedRef,
    onVersionReconcileRef,
    onViewCountChangedRef,
    replaceThreadsIfChanged,
  ])

  return {
    state,
    presence: liveEnabled ? state.presence : emptyPresence,
    totalCount,
    returnFocusRef,
    requestedFilter: requestedFilterRef.current,
    isCurrentArtifactId,
    openPanel,
    replaceThreads,
    changePanelOpen,
    targetThread,
    startTextSelection,
    openPendingComposer,
    openInlineThread,
    closeInlinePopover,
    clearPendingTextAnchor,
  }
}

type LiveMessage =
  | { type: 'presence'; users: ViewerPresence[] }
  | {
      type: 'comments-changed'
      originMutationId?: string
      originUserId?: string
    }
  | { type: 'view-count-changed'; viewCount: number }
  | { type: 'version-changed'; currentVersionId: string }
  | { type: 'pong' }

export function parseLiveMessage(data: unknown): LiveMessage | null {
  if (typeof data !== 'string') return null
  if (data === 'pong') return { type: 'pong' }
  const parsed = parseJson(data)
  if (!parsed || typeof parsed !== 'object') return null
  const message = parsed as {
    type?: unknown
    users?: unknown
    viewCount?: unknown
    currentVersionId?: unknown
    originMutationId?: unknown
    originUserId?: unknown
  }
  if (message.type === 'comments-changed') {
    return typeof message.originMutationId === 'string' &&
      message.originMutationId.length > 0 &&
      typeof message.originUserId === 'string' &&
      message.originUserId.length > 0
      ? {
          type: message.type,
          originMutationId: message.originMutationId,
          originUserId: message.originUserId,
        }
      : { type: message.type }
  }
  if (message.type === 'version-changed') {
    return typeof message.currentVersionId === 'string' &&
      message.currentVersionId.length > 0
      ? { type: message.type, currentVersionId: message.currentVersionId }
      : null
  }
  if (message.type === 'view-count-changed') {
    const viewCount = parseViewCount(message.viewCount)
    if (viewCount === null) return null
    return { type: message.type, viewCount }
  }
  if (message.type !== 'presence' || !Array.isArray(message.users)) return null
  const users = message.users.flatMap((user): ViewerPresence[] => {
    if (!user || typeof user !== 'object') return []
    const raw = user as Record<string, unknown>
    if (
      typeof raw.id !== 'string' ||
      typeof raw.name !== 'string' ||
      typeof raw.initial !== 'string' ||
      (raw.image !== null && typeof raw.image !== 'string')
    ) {
      return []
    }
    return [
      {
        id: raw.id,
        name: raw.name,
        initial: raw.initial,
        image: raw.image,
      },
    ]
  })
  return { type: 'presence', users }
}

function parseViewCount(value: unknown): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 0
  ) {
    return null
  }
  return value
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return null
  }
}

function useLatestVersionNotice({
  artifactId,
  currentVersionId,
  liveAvailable,
}: {
  artifactId: string
  currentVersionId: string | null
  liveAvailable: boolean
}) {
  const currentVersionIdRef = useLatestRef(currentVersionId)
  const liveAvailableRef = useLatestRef(liveAvailable)
  const latestCheckSeqRef = useRef(0)
  const latestCheckAbortRef = useRef<AbortController | null>(null)
  const latestCheckKindRef = useRef<LatestVersionCheckKind | null>(null)
  const latestCheckStartedAtRef = useRef(0)
  const latestCheckRetryTimerRef = useRef<number | null>(null)
  const latestCheckRetryKindRef = useRef<LatestVersionCheckKind | null>(null)
  const [notice, setNotice] = useState(() => ({
    currentVersionId,
    hasNewerVersion: false,
  }))

  if (notice.currentVersionId !== currentVersionId) {
    setNotice({ currentVersionId, hasNewerVersion: false })
  }

  const abortLatestVersionCheck = useCallback((kind?: 'fallback') => {
    if (kind && latestCheckKindRef.current !== kind) return
    latestCheckAbortRef.current?.abort()
    latestCheckAbortRef.current = null
    latestCheckKindRef.current = null
  }, [])

  const clearLatestVersionRetry = useCallback(
    (kind?: LatestVersionCheckKind) => {
      if (latestCheckRetryTimerRef.current === null) return
      if (kind && latestCheckRetryKindRef.current !== kind) return
      window.clearTimeout(latestCheckRetryTimerRef.current)
      latestCheckRetryTimerRef.current = null
      latestCheckRetryKindRef.current = null
    },
    [],
  )

  const markVersionChanged = useCallback(
    (nextVersionId: string) => {
      const current = currentVersionIdRef.current
      if (!current) return
      if (nextVersionId !== current) {
        latestCheckSeqRef.current += 1
      }
      setNotice((previous) =>
        previous.currentVersionId === current
          ? { ...previous, hasNewerVersion: nextVersionId !== current }
          : previous,
      )
    },
    [currentVersionIdRef],
  )

  const checkLatestVersion = useCallback(
    async function checkLatestVersion(
      options: { kind: LatestVersionCheckKind } = {
        kind: 'fallback',
      },
    ) {
      if (!currentVersionIdRef.current) return
      if (liveAvailableRef.current && options.kind !== 'reconcile') return
      const now = Date.now()
      const elapsed = now - latestCheckStartedAtRef.current
      if (elapsed < LATEST_VERSION_RECONCILE_COOLDOWN_MS) {
        const retryDelay = LATEST_VERSION_RECONCILE_COOLDOWN_MS - elapsed
        const scheduleRetry = () => {
          latestCheckRetryTimerRef.current = window.setTimeout(() => {
            latestCheckRetryTimerRef.current = null
            latestCheckRetryKindRef.current = null
            void checkLatestVersion(options)
          }, retryDelay)
          latestCheckRetryKindRef.current = options.kind
        }
        if (
          latestCheckRetryTimerRef.current !== null &&
          shouldPromoteLatestVersionRetry(
            latestCheckRetryKindRef.current,
            options.kind,
          )
        ) {
          clearLatestVersionRetry('fallback')
        }
        if (latestCheckRetryTimerRef.current === null) {
          scheduleRetry()
        }
        return
      }
      clearLatestVersionRetry()
      latestCheckStartedAtRef.current = now
      const seq = latestCheckSeqRef.current + 1
      latestCheckSeqRef.current = seq
      latestCheckAbortRef.current?.abort()
      const controller = new AbortController()
      latestCheckAbortRef.current = controller
      latestCheckKindRef.current = options.kind
      const result = await fetchJsonWithViewerTimeout<{
        currentVersionId?: unknown
      }>(`/api/shareables/${encodeURIComponent(artifactId)}/versions`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      }).catch((error: unknown) => {
        logViewerNetworkEvent({
          channel: 'fetch',
          purpose: 'versions',
          state: 'failed',
          reason: viewerFetchFailureReason(error),
        })
        return null
      })
      if (latestCheckAbortRef.current === controller) {
        latestCheckAbortRef.current = null
        latestCheckKindRef.current = null
      }
      const response = result?.response
      if (!response?.ok) {
        if (response) {
          logViewerNetworkEvent({
            channel: 'fetch',
            purpose: 'versions',
            state: 'response-error',
            status: response.status,
            cfRay: cfRayFrom(response),
          })
        }
        return
      }
      const body = result?.body ?? null
      if (typeof body?.currentVersionId !== 'string') return
      if (seq !== latestCheckSeqRef.current) return
      markVersionChanged(body.currentVersionId)
    },
    [
      artifactId,
      clearLatestVersionRetry,
      currentVersionIdRef,
      liveAvailableRef,
      markVersionChanged,
    ],
  )

  useEffect(() => {
    latestCheckStartedAtRef.current = 0
    latestCheckSeqRef.current += 1
    clearLatestVersionRetry()
    abortLatestVersionCheck()
    return () => {
      clearLatestVersionRetry()
      abortLatestVersionCheck()
    }
  }, [abortLatestVersionCheck, artifactId, clearLatestVersionRetry])

  useEffect(() => {
    if (!liveAvailable) return
    if (
      shouldClearLatestVersionRetryOnLiveAvailable(
        latestCheckRetryKindRef.current,
      )
    ) {
      clearLatestVersionRetry('fallback')
    }
    if (latestCheckKindRef.current === 'fallback') {
      latestCheckSeqRef.current += 1
      abortLatestVersionCheck('fallback')
    }
  }, [abortLatestVersionCheck, clearLatestVersionRetry, liveAvailable])

  useEffect(() => {
    if (liveAvailable) return
    void checkLatestVersion({ kind: 'fallback' })
    const interval = window.setInterval(() => {
      void checkLatestVersion({ kind: 'fallback' })
    }, LATEST_VERSION_FALLBACK_INTERVAL_MS)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void checkLatestVersion({ kind: 'fallback' })
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [checkLatestVersion, liveAvailable])

  return {
    hasNewerVersion: notice.hasNewerVersion,
    markVersionChanged,
    reconcile: useCallback(
      () => checkLatestVersion({ kind: 'reconcile' }),
      [checkLatestVersion],
    ),
    clearNewerVersion: useCallback(
      () =>
        setNotice((previous) => ({
          ...previous,
          hasNewerVersion: false,
        })),
      [],
    ),
  }
}

type ViewerShellProps = {
  artifact: ViewerShellArtifact
  user: UserInfo | null
  renderType: ArtifactType | null
  sandboxUrl: string | null
  bundlePaths: ReadonlyArray<string>
  fallbackToIndex?: boolean
  children?: ReactNode
  appOrigin?: string
  analyticsMode?: 'enabled' | 'disabled'
  linkSafety?: { lowTrust: boolean } | null
}
export function ViewerShell(props: ViewerShellProps) {
  return <ViewerShellView {...useViewerShellController(props)} />
}

function useViewerShellController({
  artifact,
  user,
  renderType,
  sandboxUrl,
  bundlePaths,
  fallbackToIndex = false,
  children,
  appOrigin,
  analyticsMode = 'disabled',
  linkSafety,
}: ViewerShellProps) {
  const { t } = useT()
  const routerLocation = useLocation()
  const navigate = useNavigate()
  const revalidator = useRevalidator()
  const [state, dispatch] = useReducer(
    viewerShellReducer,
    artifact.id,
    createViewerShellState,
  )
  // artifact 切替はコメント reducer と同じく render-phase 比較で検知し、
  // 閲覧者パネルを閉じる (取得済みリストは useViewerList が破棄する)。
  if (state.artifactId !== artifact.id) {
    dispatch({ type: 'artifact-changed', artifactId: artifact.id })
  }
  const canReplaceFile = user !== null && artifact.canReplaceFile === true
  const isHistoricalVersion = artifact.isHistoricalVersion === true
  const canReplaceCurrentFile = canReplaceFile && !isHistoricalVersion
  const canViewHistory = artifact.canViewHistory === true
  const replaceMode: 'single' | 'static_site' =
    renderType === 'static_site' ? 'static_site' : 'single'
  const frameTitle = displayTitle(artifact)
  const historyReturnFocusRef = useRef<HTMLElement | null>(null)
  const accessRequestId = new URLSearchParams(routerLocation.search).get(
    'access-request',
  )
  const targetCommentId = new URLSearchParams(routerLocation.search).get(
    'comment',
  )
  const [accessRequestsOpen, setAccessRequestsOpen] = useState(
    accessRequestId !== null,
  )
  useEffect(() => {
    if (accessRequestId !== null) setAccessRequestsOpen(true)
  }, [accessRequestId])
  const closeAccessRequests = useCallback(() => {
    setAccessRequestsOpen(false)
    if (accessRequestId === null) return
    const params = new URLSearchParams(routerLocation.search)
    params.delete('access-request')
    if (targetCommentId !== null) params.delete('comment')
    void navigate(
      {
        pathname: routerLocation.pathname,
        search: params.size > 0 ? `?${params.toString()}` : '',
      },
      { replace: true, preventScrollReset: true },
    )
  }, [
    accessRequestId,
    navigate,
    routerLocation.pathname,
    routerLocation.search,
    targetCommentId,
  ])
  // コメントパネル (全体コメントの表示・新規作成) と live 接続 (在席・
  // comments-changed) はコメント可能な種別で有効化する。接続は本文を抱える
  // sandbox iframe ではなく apex 側の閲覧画面から張るため、static_site でも
  // sandbox の隔離に触れない。
  const commentsEnabled =
    user !== null &&
    !isHistoricalVersion &&
    artifactSupportsComments(renderType)
  const [liveConnected, setLiveConnected] = useState(false)
  const latestVersion = useLatestVersionNotice({
    artifactId: artifact.id,
    currentVersionId: isHistoricalVersion
      ? null
      : (artifact.currentVersionId ?? null),
    liveAvailable: commentsEnabled && liveConnected,
  })
  const initialCommentThreads = artifact.comments ?? emptyCommentThreads
  const [viewCountState, setViewCountState] = useState(() => ({
    artifactId: artifact.id,
    viewCount: artifact.viewCount,
  }))
  const viewCount =
    viewCountState.artifactId === artifact.id
      ? Math.max(viewCountState.viewCount, artifact.viewCount)
      : artifact.viewCount
  const artifactForChrome = useMemo(
    () => ({ ...artifact, viewCount, canReplaceFile: canReplaceCurrentFile }),
    [artifact, canReplaceCurrentFile, viewCount],
  )
  const handleViewCountChanged = useCallback(
    (nextViewCount: number) => {
      setViewCountState((current) =>
        mergeLiveViewCount(current, artifact, nextViewCount),
      )
    },
    [artifact],
  )
  const handleCommentsPanelOpened = useCallback(() => {
    closeAccessRequests()
    dispatch({ type: 'history-open-changed', open: false })
    // コメントパネルが開く合流点。閲覧者パネルとの排他 (AC 7) をここで足す。
    // 強制閉鎖なのでフォーカスは入口へ戻さない (開いたパネルに残す)。
    dispatch({
      type: 'viewer-list-open-changed',
      open: false,
      reason: 'forced',
    })
  }, [closeAccessRequests])
  // 本文範囲コメントは本文の選択を要するため html / md のみ。static_site の本文は
  // 別オリジンの sandbox iframe にあり選択を取得できない。
  const textAnchorsEnabled =
    !isHistoricalVersion && (renderType === 'html' || renderType === 'md')
  // 全体コメントの新規作成 composer は static_site のみ。html / md は本文選択で付ける。
  const newThreadComposerEnabled = renderType === 'static_site'
  const comments = useViewerComments({
    artifactId: artifact.id,
    currentUserId: user?.id ?? null,
    currentVersionId: artifact.currentVersionId ?? null,
    initialThreads: initialCommentThreads,
    targetCommentId,
    liveEnabled: commentsEnabled,
    onViewCountChanged: handleViewCountChanged,
    onVersionChanged: latestVersion.markVersionChanged,
    onVersionReconcile: latestVersion.reconcile,
    onLiveConnectionChanged: setLiveConnected,
    onPanelOpened: handleCommentsPanelOpened,
  })
  // 閲覧者パネル。入口 (メタ行・メニュー) は showViewerListMetaEntry ゲート。
  const viewerListAvailable = artifact.showViewerListMetaEntry === true
  const viewerListReturnFocusRef = useRef<HTMLElement | null>(null)
  const viewerList = useViewerList({
    artifactId: artifact.id,
    open: state.viewerListOpen,
  })
  const viewerListOpen = state.viewerListOpen
  const changeViewerListOpen = useCallback(
    (open: boolean) => {
      if (open) {
        closeAccessRequests()
        // 双方向排他: 閲覧者パネルを開くとコメントパネルも閉じる (AC 7)。
        comments.changePanelOpen(false)
        viewerList.openFetch()
      }
      dispatch({ type: 'viewer-list-open-changed', open })
    },
    [closeAccessRequests, comments.changePanelOpen, viewerList.openFetch],
  )
  const handleViewerListEntrySelect = useCallback(
    (from: ViewerListOpenedFrom, returnFocusTo: HTMLElement | null) => {
      if (from === 'meta' && viewerListOpen) {
        dispatch({ type: 'viewer-list-open-changed', open: false })
        return
      }
      viewerListReturnFocusRef.current = returnFocusTo ?? getActiveElement()
      closeAccessRequests()
      comments.changePanelOpen(false)
      viewerList.openFetch()
      dispatch({ type: 'viewer-list-open-changed', open: true })
    },
    [
      closeAccessRequests,
      comments.changePanelOpen,
      viewerList.openFetch,
      viewerListOpen,
    ],
  )
  const exportSupported =
    !isHistoricalVersion && artifactSupportsExport(renderType)
  const initialExportPath = useMemo(
    () => defaultExportPath(artifact.entrypointPath, renderType),
    [artifact.entrypointPath, renderType],
  )
  const exportResetKey = `${artifact.id}:${artifact.currentVersionId ?? ''}:${initialExportPath}`
  const [frameExportState, setFrameExportState] = useState<{
    key: string
    path: string | null
  }>(() => ({ key: exportResetKey, path: null }))
  let currentFrameExportPath = frameExportState.path
  if (frameExportState.key !== exportResetKey) {
    currentFrameExportPath = null
    setFrameExportState({ key: exportResetKey, path: null })
  }
  const currentExportPath = currentFrameExportPath ?? initialExportPath
  const setFrameExportPath = useCallback(
    (path: string) => {
      setFrameExportState({ key: exportResetKey, path })
    },
    [exportResetKey],
  )

  const exportPrintLabels = useMemo<ExportPrintLabels>(
    () => ({
      savePdf: t('export.printSavePdf'),
      backgroundHint: t('export.printBackgroundHint'),
      preparing: t('export.printPreparing'),
      heightLimited: t('export.printHeightLimited'),
    }),
    [t],
  )

  const runExportAction = useCallback(
    async (
      action: 'copy' | 'download' | 'pdf',
      run: (source: ExportSourceData) => Promise<void> | void,
    ): Promise<boolean> => {
      if (!exportSupported) {
        toast.error(t('toast.exportUnsupported'))
        return false
      }
      const fetched = await fetchExportSource(artifact.id, currentExportPath)
      if (!fetched.ok) {
        toast.error(
          fetched.reason === 'unsupported'
            ? t('toast.exportUnsupported')
            : t('toast.exportExtractFailed'),
        )
        return false
      }
      try {
        await run(fetched.data)
        return true
      } catch {
        toast.error(
          action === 'copy'
            ? t('toast.exportCopyFailed')
            : t('toast.exportExtractFailed'),
        )
        return false
      }
    },
    [artifact.id, currentExportPath, exportSupported, t],
  )

  const handleCopyMarkdown = useCallback(() => {
    void runExportAction('copy', async (source) => {
      const markdown = await resolveExportMarkdown(source)
      if (!markdown) {
        throw new Error('Markdown export failed')
      }
      await navigator.clipboard.writeText(markdown)
      toast.success(t('toast.exportCopied'))
    })
  }, [runExportAction, t])

  const handleDownloadMarkdown = useCallback(() => {
    void runExportAction('download', async (source) => {
      const markdown = await resolveExportMarkdown(source)
      if (!markdown) {
        throw new Error('Markdown export failed')
      }
      downloadText(
        markdownDownloadFileName(source.fileName),
        markdown,
        'text/markdown;charset=utf-8',
      )
    })
  }, [runExportAction])

  const handleDownloadHtml = useCallback(() => {
    void runExportAction('download', async (source) => {
      const html = await resolveExportHtml(artifact.id, source)
      if (!html) {
        throw new Error('HTML export failed')
      }
      downloadText(
        htmlDownloadFileName(source.fileName),
        html,
        'text/html;charset=utf-8',
      )
    })
  }, [artifact.id, runExportAction])

  const handleDownloadPdf = useCallback(() => {
    const printWindow = openPrintWindow()
    if (!printWindow) {
      toast.error(t('toast.exportPopupBlocked'))
      return
    }
    void runExportAction('pdf', async (source) => {
      await writePrintPdf(printWindow, artifact.id, source, exportPrintLabels)
    }).then((ok) => {
      if (!ok) printWindow.close()
    })
  }, [artifact.id, exportPrintLabels, runExportAction, t])

  useEffect(() => {
    if (!targetCommentId) return
    const params = new URLSearchParams(routerLocation.search)
    params.delete('comment')
    if (accessRequestId !== null) params.delete('access-request')
    navigate(
      {
        pathname: routerLocation.pathname,
        search: params.toString() ? `?${params.toString()}` : '',
      },
      { replace: true, preventScrollReset: true },
    )
  }, [
    routerLocation.pathname,
    routerLocation.search,
    navigate,
    accessRequestId,
    targetCommentId,
  ])

  // 新 version 登録成功後に panel を auto-close するための timer。
  // 1.2s 遅延で「list に新 version が積まれた」を user が視認してから閉じる。
  // 再開時 / unmount 時には残ってる timer を clear して race を防ぐ。
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleClosePanel = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    closeTimerRef.current = setTimeout(() => {
      dispatch({ type: 'history-open-changed', open: false })
      closeTimerRef.current = null
    }, 1200)
  }, [])
  useEffect(
    () => () => {
      if (closeTimerRef.current) clearTimeout(closeTimerRef.current)
    },
    [],
  )

  const replaceVersion = useReplaceVersion(artifact.id, {
    expectedVersionId: artifact.currentVersionId,
    onSuccess: scheduleClosePanel,
  })

  const submitReplaceVersion = useCallback(
    async (files: File[]) => {
      const input: ReplaceVersionInput =
        replaceMode === 'static_site'
          ? { kind: 'static_site', files }
          : { kind: 'single', files }
      dispatch({ type: 'uploading-changed', uploading: true })
      try {
        await replaceVersion(input)
      } finally {
        dispatch({ type: 'uploading-changed', uploading: false })
      }
    },
    [replaceMode, replaceVersion],
  )

  useEffect(() => {
    if (!canReplaceCurrentFile || state.uploading) return

    function onDragEnter(event: DragEvent) {
      if (!hasLocalFiles(event.dataTransfer)) return
      comments.changePanelOpen(false)
      dispatch({ type: 'file-drag-entered' })
    }

    function clearDropState() {
      dispatch({ type: 'drop-finished' })
    }

    // OS file drag は drag source が OS のため `dragend` が window で発火しない。
    // drop が history panel 内 dropzone で発火して stopPropagation された場合も
    // viewer の DropCatcher が active のまま残るので、window-level の `drop` で
    // 必ず catcher を off にする (capture phase で常に拾う)。viewport 外への
    // dragleave (relatedTarget が null) も同様に clear する。
    function onWindowDrop() {
      clearDropState()
    }
    function onWindowDragLeave(event: DragEvent) {
      if (event.relatedTarget !== null) return
      clearDropState()
    }

    window.addEventListener('dragenter', onDragEnter, { capture: true })
    window.addEventListener('dragend', clearDropState, { capture: true })
    window.addEventListener('drop', onWindowDrop, { capture: true })
    window.addEventListener('dragleave', onWindowDragLeave, { capture: true })
    return () => {
      window.removeEventListener('dragenter', onDragEnter, { capture: true })
      window.removeEventListener('dragend', clearDropState, { capture: true })
      window.removeEventListener('drop', onWindowDrop, { capture: true })
      window.removeEventListener('dragleave', onWindowDragLeave, {
        capture: true,
      })
    }
  }, [canReplaceCurrentFile, comments.changePanelOpen, state.uploading])

  const currentVersionParams = new URLSearchParams(routerLocation.search)
  currentVersionParams.delete('version')
  const currentVersionHref = `${routerLocation.pathname}${
    currentVersionParams.toString() ? `?${currentVersionParams}` : ''
  }`

  const handleFiles = (files: FileList | File[]) => {
    const list = Array.from(files)
    if (list.length === 0) {
      toast.error(t('upload.error.missingFile'))
      return
    }
    void submitReplaceVersion(list)
  }

  const handleDrop = (dataTransfer: DataTransfer) => {
    if (replaceMode === 'static_site') {
      const fallbackFiles = Array.from(dataTransfer.files)
      void filesFromDrop(dataTransfer).then(handleFiles, () =>
        fallbackFiles.length > 0
          ? handleFiles(fallbackFiles)
          : toast.error(t('upload.error.dropReadFailed')),
      )
      return
    }
    handleFiles(dataTransfer.files)
  }

  return {
    artifact: artifactForChrome,
    user,
    renderType,
    sandboxUrl,
    bundlePaths,
    fallbackToIndex,
    children,
    appOrigin,
    analyticsMode,
    linkSafety,
    state,
    dispatch,
    canReplaceFile: canReplaceCurrentFile,
    canViewHistory,
    isHistoricalVersion,
    exportActions:
      user && !isHistoricalVersion && artifactSupportsExport(renderType)
        ? {
            copyMarkdown: handleCopyMarkdown,
            downloadHtml: handleDownloadHtml,
            downloadMarkdown: handleDownloadMarkdown,
            downloadPdf: handleDownloadPdf,
          }
        : null,
    currentVersionHref,
    frameTitle,
    historyReturnFocusRef,
    accessRequestsOpen,
    setAccessRequestsOpen,
    closeAccessRequests,
    latestVersion,
    comments,
    textAnchorsEnabled,
    commentsEnabled,
    newThreadComposerEnabled,
    revalidator,
    replaceMode,
    viewerListAvailable,
    viewerList,
    viewerListReturnFocusRef,
    changeViewerListOpen,
    handleViewerListEntrySelect,
    submitReplaceVersion,
    handleDrop,
    setFrameExportPath,
  }
}

type ViewerShellController = ReturnType<typeof useViewerShellController>

export function mergeLiveViewCount(
  current: { artifactId: string; viewCount: number },
  artifact: { id: string; viewCount: number },
  nextViewCount: number,
): { artifactId: string; viewCount: number } {
  const displayedViewCount =
    current.artifactId === artifact.id
      ? Math.max(current.viewCount, artifact.viewCount)
      : artifact.viewCount
  if (nextViewCount < displayedViewCount) {
    return { artifactId: artifact.id, viewCount: displayedViewCount }
  }
  return { artifactId: artifact.id, viewCount: nextViewCount }
}

function ViewerShellView({
  artifact,
  user,
  renderType,
  sandboxUrl,
  bundlePaths,
  fallbackToIndex,
  children,
  state,
  dispatch,
  canReplaceFile,
  canViewHistory,
  isHistoricalVersion,
  exportActions,
  currentVersionHref,
  frameTitle,
  historyReturnFocusRef,
  accessRequestsOpen,
  setAccessRequestsOpen,
  closeAccessRequests,
  latestVersion,
  comments,
  textAnchorsEnabled,
  commentsEnabled,
  newThreadComposerEnabled,
  revalidator,
  replaceMode,
  viewerListAvailable,
  viewerList,
  viewerListReturnFocusRef,
  changeViewerListOpen,
  handleViewerListEntrySelect,
  submitReplaceVersion,
  handleDrop,
  setFrameExportPath,
  appOrigin,
  analyticsMode,
  linkSafety,
}: ViewerShellController) {
  const { t } = useT()
  const collapseToggleRef = useRef<HTMLButtonElement | null>(null)

  return (
    <div className="bg-surface-warm fixed inset-x-0 top-0 bottom-[var(--consent-banner-height)] flex flex-col overflow-hidden overscroll-none">
      <ViewerChrome
        artifact={artifact}
        user={user}
        linkOrigin={linkSafety ? { shareableId: artifact.id } : null}
        renderType={renderType}
        appOrigin={appOrigin}
        analyticsMode={analyticsMode}
        onHistoryOpenChange={(open, options) => {
          if (open) {
            historyReturnFocusRef.current =
              options?.returnFocusTo ?? getActiveElement()
            closeAccessRequests()
          }
          if (open) comments.changePanelOpen(false)
          dispatch({ type: 'history-open-changed', open })
        }}
        commentCount={comments.totalCount}
        presence={comments.presence}
        onCommentsOpen={commentsEnabled ? comments.openPanel : undefined}
        viewerListOpen={state.viewerListOpen}
        onViewerListEntrySelect={
          viewerListAvailable ? handleViewerListEntrySelect : undefined
        }
        accessRequestsOpen={accessRequestsOpen}
        onAccessRequestsOpenChange={(open) => {
          if (open) setAccessRequestsOpen(true)
          else closeAccessRequests()
        }}
        onAccessRequestsOpen={() => {
          comments.returnFocusRef.current = null
          historyReturnFocusRef.current = null
          comments.changePanelOpen(false)
          dispatch({ type: 'history-open-changed', open: false })
          dispatch({
            type: 'viewer-list-open-changed',
            open: false,
            reason: 'forced',
          })
        }}
        collapsible={sandboxUrl !== null}
        collapsed={state.chromeCollapsed}
        collapseToggleRef={collapseToggleRef}
        onCollapsedChange={(collapsed) => {
          dispatch({ type: 'chrome-collapsed-changed', collapsed })
        }}
        onCopyMarkdown={exportActions?.copyMarkdown}
        onDownloadHtml={exportActions?.downloadHtml}
        onDownloadMarkdown={exportActions?.downloadMarkdown}
        onDownloadPdf={exportActions?.downloadPdf}
      />
      {isHistoricalVersion ? (
        <div className="border-border bg-background flex min-h-11 items-center justify-between gap-3 border-b px-3 py-2 text-sm">
          <strong>
            {t('history.viewingVersion', {
              version: `v${artifact.displayedVersionOrdinal ?? '-'}`,
            })}
          </strong>
          <Link
            to={currentVersionHref}
            preventScrollReset
            className="text-link font-medium no-underline hover:underline"
          >
            {t('history.backToCurrent')}
          </Link>
        </div>
      ) : null}
      {sandboxUrl ? (
        <SandboxFrame
          key={`${artifact.id}:${artifact.displayedVersionId ?? artifact.currentVersionId ?? ''}:${renderType ?? ''}`}
          shareableId={artifact.id}
          versionId={
            artifact.displayedVersionId ?? artifact.currentVersionId ?? ''
          }
          url={sandboxUrl}
          name={frameTitle}
          mermaidEnabled={renderType === 'md'}
          textAnchorsEnabled={textAnchorsEnabled}
          linkNavigationMode={
            renderType ? linkNavigationModeFor(renderType) : 'document'
          }
          bundlePaths={bundlePaths}
          fallbackToIndex={fallbackToIndex}
          commentThreads={comments.state.threads}
          targetThreadId={comments.state.targetThreadId}
          highlightThreadId={
            comments.state.inlineThreadId ?? comments.state.targetThreadId
          }
          followsAppTheme={renderType === 'md'}
          lowTrust={linkSafety?.lowTrust === true}
          onTextSelection={(selection) => {
            if (!textAnchorsEnabled) return
            comments.startTextSelection(selection)
          }}
          onTextSelectionClear={() => {
            if (!textAnchorsEnabled) return
            comments.clearPendingTextAnchor()
          }}
          onThreadSelect={(threadId, rect) => {
            if (!textAnchorsEnabled) return
            comments.openInlineThread(threadId, rect)
          }}
          onOutsidePointerDown={() => {
            if (!textAnchorsEnabled) return
            comments.closeInlinePopover()
            comments.clearPendingTextAnchor()
          }}
          onFramePathChange={
            renderType === 'static_site' ? setFrameExportPath : undefined
          }
          sandboxPermissions="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads"
        >
          {canReplaceFile && !state.uploading && state.dropCatcherVisible ? (
            <DropCatcher
              active={state.dropActive}
              onActiveChange={(active) =>
                dispatch({ type: 'drop-active-changed', active })
              }
              onFinish={() => dispatch({ type: 'drop-finished' })}
              onDrop={handleDrop}
            />
          ) : null}
        </SandboxFrame>
      ) : (
        children
      )}
      {canViewHistory ? (
        <VersionWidget
          hidden={state.chromeCollapsed}
          versions={artifact.versions ?? []}
          canReplaceFile={canReplaceFile}
          onSubmit={canReplaceFile ? submitReplaceVersion : undefined}
          replaceMode={replaceMode}
          uploading={state.uploading}
          hasNewerVersion={latestVersion.hasNewerVersion}
          onShowLatest={() => {
            latestVersion.clearNewerVersion()
            revalidator.revalidate()
          }}
          onOpenHistory={(returnFocusTo) => {
            historyReturnFocusRef.current = returnFocusTo ?? getActiveElement()
            closeAccessRequests()
            dispatch({ type: 'history-open-changed', open: true })
            comments.changePanelOpen(false)
          }}
          revisitContext={artifact.revisitContext}
          onCommentsOpen={commentsEnabled ? comments.openPanel : undefined}
        />
      ) : null}
      {canViewHistory ? (
        <HistoryPanel
          versions={artifact.versions ?? []}
          open={state.historyOpen}
          onOpenChange={(open) => {
            if (open) {
              closeAccessRequests()
              comments.changePanelOpen(false)
            }
            dispatch({ type: 'history-open-changed', open })
          }}
          returnFocusRef={historyReturnFocusRef}
          collapsedFallbackRef={collapseToggleRef}
          topbarCollapsed={state.chromeCollapsed}
          canReplaceFile={canReplaceFile}
          onSubmit={canReplaceFile ? submitReplaceVersion : undefined}
          replaceMode={replaceMode}
          uploading={state.uploading}
          dropActive={state.dropActive}
        />
      ) : null}
      {textAnchorsEnabled ? (
        <>
          {comments.state.pendingTextAnchor &&
          !comments.state.pendingComposerOpen ? (
            <TextSelectionCommentChip
              key={`chip:${pendingAnchorKey(comments.state.pendingTextAnchor)}`}
              anchor={comments.state.pendingTextAnchor}
              onStart={comments.openPendingComposer}
              onDismiss={comments.clearPendingTextAnchor}
            />
          ) : null}
          {comments.state.pendingTextAnchor &&
          comments.state.pendingComposerOpen ? (
            <TextSelectionCommentPopover
              key={`selection:${pendingAnchorKey(comments.state.pendingTextAnchor)}`}
              shareableId={artifact.id}
              anchor={comments.state.pendingTextAnchor}
              isCurrentShareableId={comments.isCurrentArtifactId}
              onThreadsChange={comments.replaceThreads}
              onClose={comments.clearPendingTextAnchor}
            />
          ) : null}
          <InlineCommentPopover
            key={`thread:${comments.state.inlineThreadId ?? 'none'}`}
            shareableId={artifact.id}
            thread={
              comments.state.inlineThreadId
                ? (comments.state.threads.find(
                    (thread) => thread.id === comments.state.inlineThreadId,
                  ) ?? null)
                : null
            }
            rect={comments.state.inlineThreadRect}
            isCurrentShareableId={comments.isCurrentArtifactId}
            onThreadsChange={comments.replaceThreads}
            onClose={comments.closeInlinePopover}
            onOpenConversation={(threadId) => {
              // 履歴・閲覧者パネルのクローズは targetThread → onPanelOpened
              // (handleCommentsPanelOpened) が担うため、直接 dispatch しない。
              comments.targetThread(threadId, { scroll: 'start' })
            }}
          />
        </>
      ) : null}
      {commentsEnabled && user ? (
        <CommentPanel
          key={artifact.id}
          shareableId={artifact.id}
          viewerUserId={user.id}
          threads={comments.state.threads}
          onThreadsChange={comments.replaceThreads}
          isCurrentShareableId={comments.isCurrentArtifactId}
          open={comments.state.panelOpen}
          onOpenChange={comments.changePanelOpen}
          targetThreadId={comments.state.targetThreadId}
          targetThreadScroll={comments.state.targetThreadScroll}
          onThreadNavigate={(thread) =>
            comments.targetThread(thread.id, { scroll: 'start' })
          }
          returnFocusRef={comments.returnFocusRef}
          collapsedFallbackRef={collapseToggleRef}
          requestedFilter={comments.requestedFilter}
          topbarCollapsed={state.chromeCollapsed}
          showNewThreadComposer={newThreadComposerEnabled}
        />
      ) : null}
      {viewerListAvailable && user ? (
        <ViewerListPanel
          open={state.viewerListOpen}
          onOpenChange={changeViewerListOpen}
          rows={viewerList.rows}
          totalViewers={viewerList.totalViewers}
          status={viewerList.status}
          loadingMore={viewerList.loadingMore}
          nextCursor={viewerList.nextCursor}
          onLoadMore={viewerList.loadMore}
          onRetry={viewerList.retry}
          returnFocusRef={viewerListReturnFocusRef}
          closeReason={state.viewerListCloseReason}
          skipReturnFocus={state.chromeCollapsed}
          topbarCollapsed={state.chromeCollapsed}
        />
      ) : null}
    </div>
  )
}
