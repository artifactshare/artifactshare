import { acquireCommentRuntime } from './comment-runtime-browser'
import { isCommentAuthErrorStatus } from './comment-refresh'
import {
  createCommentSession,
  type CommentSession,
  type CommentRecoveryTicket,
} from './comment-session'
import { CommentPageSessionContext } from './use-comment-page'
import { type AppliedCommentMutationEchoes } from './comment-mutation-echo'
export {
  rememberAppliedCommentMutationEcho,
  consumeAppliedCommentMutationEcho,
} from './comment-mutation-echo'
export {
  createCommentRefreshScheduler,
  runCommentRefreshWithAuthRecovery,
  shouldDeferCommentRefreshDuringMutation,
} from './comment-refresh'
import { DELIVERY_UNAVAILABLE_PATH } from '~/lib/hosts'
import { type CommentThreadPatch } from './comment-history'
import { firstNewCommentThread } from './comment-order'
import type {
  NewCommentMessage,
  ViewerRevisitContext,
} from '~/lib/viewer-revisit'
import type { AnchorResolutionMessage } from '~/lib/csp-reporter'
import { toast } from 'sonner'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useLocation, useNavigate, useRevalidator } from 'react-router'
import { VersionWidget, type VersionRow } from './history-panel'
import { ViewerHistoryPanel } from './viewer-history-panel'
import { DropCatcher } from './drop-catcher'
import { hasLocalFiles } from './drag-files'
import { ViewerChrome } from './viewer-chrome'
import { CommentLocationsContext } from './comment-locations-context'
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
import {
  pdfCommentPage,
  PdfPageContext,
  type PdfCommentPage,
  type PdfPageBridge,
} from './pdf-page-context'
import { type TextSelectionMessage } from '~/lib/csp-reporter'
import { type CommentThreadView } from '~/lib/comments'
import { InlineCommentPopover } from './inline-comment-popover'
import { pendingAnchorKey } from './inline-comment-popover-utils'
import { TextSelectionCommentChip } from './text-selection-comment-chip'
import { TextSelectionCommentPopover } from './text-selection-comment-popover'
import { getActiveElement } from './viewer-dom'
import { type PendingTextAnchor } from './viewer-comment-types'
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
import { latestViewerHash } from '~/lib/viewer-hash'
import { type UserInfo } from '~/lib/user'
import { filesFromDrop } from '~/lib/upload-drop-items'
import {
  artifactSupportsExport,
  defaultExportPath,
  downloadText,
  fetchExportSource,
  htmlDownloadFileName,
  markdownDownloadFileName,
  resolveExportHtml,
  resolveExportMarkdown,
  type ExportSourceData,
} from './export-actions'
import {
  cfRayFrom,
  fetchJsonWithViewerTimeout,
  VIEWER_FETCH_TIMEOUT_MS,
  logViewerNetworkEvent,
  startCommentNetworkOperation,
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
  canChangeRetention?: boolean
  retainVersions?: number | null
  publisherManaged?: boolean
  versions?: ReadonlyArray<VersionRow>
  comments?: ReadonlyArray<CommentThreadView>
  revisitContext?: ViewerRevisitContext | null
} & Parameters<typeof ViewerChrome>[0]['artifact']

const emptyCommentThreads: ReadonlyArray<CommentThreadView> = []
const emptyPresence: ReadonlyArray<ViewerPresence> = []
const LIVE_PING_INTERVAL_MS = 30_000
const LIVE_PONG_TIMEOUT_MS = 10_000
const LATEST_VERSION_RECONCILE_COOLDOWN_MS = 30_000
const LATEST_VERSION_FALLBACK_INTERVAL_MS = 5 * 60_000

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
  panelHasOpened: boolean
  focusTargetOnOpen: boolean
  targetThreadId: string | null
  targetThreadScroll: 'center' | 'start'
  /** Counts conversation choices, so choosing the same one again reopens it. */
  targetThreadRequest: number
  pendingTextAnchor: PendingTextAnchor | null
  pendingComposerOpen: boolean
  inlineThreadId: string | null
  inlineThreadRect: TextSelectionMessage['rect'] | null
}

type ViewerCommentAction =
  | { type: 'data-status-changed' }
  | {
      type: 'artifact-changed'
      artifactId: string
      currentVersionId: string | null
      threads: ReadonlyArray<CommentThreadView>
    }
  | {
      type: 'threads-replaced'
      threads: ReadonlyArray<CommentThreadView>
      deletedThreadId?: string
    }
  | {
      type: 'presence-replaced'
      presence: ReadonlyArray<ViewerPresence>
    }
  | { type: 'target-focus-consumed' }
  | { type: 'version-changed'; currentVersionId: string | null }
  | {
      type: 'panel-open-changed'
      open: boolean
      revisitThreadId?: string | null
    }
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
  | { type: 'comment-location-changed' }

async function fetchCommentThreads<T>(
  artifactId: string,
  signal: AbortSignal,
  options: Parameters<typeof fetchJsonWithViewerTimeout>[2] = {},
) {
  const lease = acquireCommentRuntime(artifactId)
  try {
    return await fetchJsonWithViewerTimeout<T>(
      `/api/shareables/${encodeURIComponent(artifactId)}/comments`,
      { headers: { accept: 'application/json' }, signal },
      options,
    )
  } finally {
    lease.release()
  }
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

type LatestVersionCheckKind = 'fallback' | 'reconcile'

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

// 本文範囲コメントは html / md と static_site の現在の版。static_site はページの
// 場所 (ファイル・ルートのパスとハッシュルート) ごとに付く。
export function viewerTextAnchorsEnabled(
  renderType: string | null | undefined,
  isHistoricalVersion: boolean,
): boolean {
  return (
    !isHistoricalVersion &&
    (renderType === 'html' ||
      renderType === 'md' ||
      renderType === 'static_site')
  )
}

export function createViewerCommentState(
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
    panelHasOpened: false,
    focusTargetOnOpen: false,
    targetThreadId,
    targetThreadScroll: 'start',
    targetThreadRequest: 0,
    pendingTextAnchor: null,
    pendingComposerOpen: false,
    inlineThreadId: null,
    inlineThreadRect: null,
  }
}

export function viewerCommentReducer(
  state: ViewerCommentState,
  action: ViewerCommentAction,
): ViewerCommentState {
  switch (action.type) {
    case 'data-status-changed':
      // Session owns errors; notify presentation without synthesizing row adoption.
      return { ...state }
    case 'artifact-changed':
      return createViewerCommentState(
        action.artifactId,
        action.currentVersionId,
        action.threads,
        null,
      )
    case 'threads-replaced': {
      const hasTargetThread =
        state.targetThreadId !== action.deletedThreadId &&
        (action.threads.some((thread) => thread.id === state.targetThreadId) ||
          !state.threads.some((thread) => thread.id === state.targetThreadId))
      const hasInlineThread = action.threads.some(
        (thread) => thread.id === state.inlineThreadId,
      )
      return {
        ...state,
        threads: action.threads,
        targetThreadId: hasTargetThread ? state.targetThreadId : null,
        focusTargetOnOpen: hasTargetThread && state.focusTargetOnOpen,
        targetThreadScroll: hasTargetThread
          ? state.targetThreadScroll
          : 'start',
        inlineThreadId: hasInlineThread ? state.inlineThreadId : null,
        inlineThreadRect: hasInlineThread ? state.inlineThreadRect : null,
      }
    }
    case 'target-focus-consumed':
      return { ...state, focusTargetOnOpen: false }
    case 'presence-replaced':
      return { ...state, presence: action.presence }
    case 'version-changed':
      return {
        ...state,
        currentVersionId: action.currentVersionId,
        focusTargetOnOpen: false,
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
            panelHasOpened: true,
            // Without a matching new message, open normally and preserve
            // existing deep-link/anchor navigation without a new focus request.
            targetThreadId: action.revisitThreadId ?? state.targetThreadId,
            targetThreadScroll:
              action.revisitThreadId == null
                ? state.targetThreadScroll
                : 'start',
            focusTargetOnOpen: Boolean(action.revisitThreadId),
            pendingTextAnchor: null,
            pendingComposerOpen: false,
            inlineThreadId: null,
            inlineThreadRect: null,
          }
        : {
            ...state,
            panelOpen: false,
            focusTargetOnOpen: false,
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
        panelHasOpened: true,
        targetThreadId: action.threadId,
        targetThreadRequest: state.targetThreadRequest + 1,
        focusTargetOnOpen: false,
        targetThreadScroll: action.scroll ?? 'start',
        inlineThreadId: null,
        inlineThreadRect: null,
      }
    case 'text-selection-started':
      return {
        ...state,
        panelOpen: false,
        focusTargetOnOpen: false,
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
        focusTargetOnOpen: false,
        targetThreadId: null,
        targetThreadScroll: 'start',
        inlineThreadId: null,
        inlineThreadRect: null,
      }
    case 'pending-text-anchor-cleared':
      return { ...state, pendingTextAnchor: null, pendingComposerOpen: false }
    case 'comment-location-changed':
      // A selection or inline conversation belongs to the location it was
      // opened on; panel conversations stay open.
      return {
        ...state,
        pendingTextAnchor: null,
        pendingComposerOpen: false,
        inlineThreadId: null,
        inlineThreadRect: null,
      }
    default: {
      const _exhaustive: never = action
      return _exhaustive
    }
  }
}

export function useViewerComments({
  framePresent,
  artifactId,
  currentUserId,
  currentVersionId,
  initialThreads,
  entryNewCommentMessages,
  targetCommentId,
  liveEnabled,
  onViewCountChanged,
  onVersionChanged,
  onVersionReconcile,
  onLiveConnectionChanged,
  onPanelOpened,
  commentLocation,
}: {
  /** Static sites: the displayed location; other locations are not checked here. */
  commentLocation?: string | null
  framePresent: boolean
  artifactId: string
  currentUserId: string | null
  currentVersionId: string | null
  initialThreads: ReadonlyArray<CommentThreadView>
  entryNewCommentMessages?: ReadonlyArray<NewCommentMessage>
  targetCommentId: string | null
  liveEnabled: boolean
  onViewCountChanged?: (viewCount: number) => void
  onVersionChanged?: (currentVersionId: string) => void
  onVersionReconcile?: () => void
  onLiveConnectionChanged?: (connected: boolean) => void
  onPanelOpened?: () => void
}) {
  const committedSession = useRef<CommentSession | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const requestedFilterRef = useRef<'all' | undefined>(undefined)
  const artifactIdRef = useLatestRef(artifactId)
  const currentUserIdRef = useLatestRef(currentUserId)
  const onViewCountChangedRef = useLatestRef(onViewCountChanged)
  const onVersionChangedRef = useLatestRef(onVersionChanged)
  const onVersionReconcileRef = useLatestRef(onVersionReconcile)
  const onLiveConnectionChangedRef = useLatestRef(onLiveConnectionChanged)
  const onPanelOpenedRef = useLatestRef(onPanelOpened)
  const [appliedCommentMutationEchoes] = useState<AppliedCommentMutationEchoes>(
    () => new Map(),
  )
  const [state, dispatchComment] = useReducer(viewerCommentReducer, null, () =>
    createViewerCommentState(
      artifactId,
      currentVersionId,
      initialThreads,
      targetCommentId,
    ),
  )
  const totalCount = state.threads.length
  const selectedThreadIdRef = useLatestRef(state.targetThreadId)

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

  const isCurrentArtifactId = useCallback(
    (requestArtifactId: string) => artifactIdRef.current === requestArtifactId,
    [artifactIdRef],
  )

  const consumeTargetFocus = useCallback(() => {
    dispatchComment({ type: 'target-focus-consumed' })
  }, [])

  const changePanelOpen = useCallback(
    (open: boolean) => {
      if (!open) {
        requestedFilterRef.current = undefined
      }
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

  const clearLocationComments = useCallback(() => {
    dispatchComment({ type: 'comment-location-changed' })
  }, [])

  const [reportedAnchorCheckingAvailable, setAnchorCheckingAvailable] =
    useState(true)
  const anchorCheckingAvailable =
    framePresent && reportedAnchorCheckingAvailable
  const panelThreads = useMemo(
    () =>
      state.threads.map((thread) =>
        (!anchorCheckingAvailable ||
          (commentLocation !== undefined &&
            thread.subject.kind === 'text' &&
            thread.subject.targetPath !== commentLocation)) &&
        thread.subject.kind === 'text' &&
        (thread.subject.checking ||
          thread.subject.positionState === 'unchecked')
          ? { ...thread, subject: { ...thread.subject, checking: false } }
          : thread,
      ),
    [state.threads, anchorCheckingAvailable, commentLocation],
  )

  const openPanel = useCallback(
    (
      returnFocusTo?: HTMLElement | null,
      requestedFilter?: 'all',
      newCommentMessages?: ReadonlyArray<NewCommentMessage>,
    ) => {
      returnFocusRef.current = returnFocusTo ?? getActiveElement()
      // Only the first ordinary open gets the entry shortcut. Reopening must
      // not replay it, and explicit navigation always keeps its own target.
      const pairs =
        newCommentMessages ??
        (!state.panelHasOpened && !state.targetThreadId
          ? entryNewCommentMessages
          : undefined)
      const threadId =
        pairs === undefined
          ? undefined
          : firstNewCommentThread(panelThreads, pairs)
      requestedFilterRef.current = threadId ? 'all' : requestedFilter
      onPanelOpenedRef.current?.()
      dispatchComment({
        type: 'panel-open-changed',
        open: true,
        revisitThreadId: threadId,
      })
    },
    [
      onPanelOpenedRef,
      panelThreads,
      entryNewCommentMessages,
      state.panelHasOpened,
      state.targetThreadId,
    ],
  )

  // Construct read-only owners during render; attach only for the committed artifact.
  const createDisplay = () => {
    let settlementListener: (() => void) | null = null
    let attached = false
    let pendingSettlement = false
    const notifySettlement = () => {
      if (!attached) return
      if (settlementListener) settlementListener()
      else pendingSettlement = true
    }
    let pageAuthListener: (() => void) | null = null
    const contacts = {
      subscribeSettlement(listener: () => void) {
        settlementListener = listener
        // Layout attachment can observe settlement before socket policy registers.
        // Coalesce only that active owner's continuation, not its data notification.
        if (attached && pendingSettlement) {
          pendingSettlement = false
          listener()
        }
        return () => {
          if (settlementListener === listener) settlementListener = null
        }
      },
      onPageAuthError(listener: () => void) {
        pageAuthListener = listener
        return () => {
          if (pageAuthListener === listener) pageAuthListener = null
        }
      },
    }
    const session = createCommentSession({
      artifactId,
      initialThreads,
      currentUserId,
      getSelectedThreadId: () => selectedThreadIdRef.current,
      getCurrentUserId: () => currentUserIdRef.current,
      appliedEchoes: appliedCommentMutationEchoes,
      onMutationSettled: notifySettlement,
      onPageAuthError: () => pageAuthListener?.(),
    })
    return {
      ...contacts,
      session,
      attach() {
        attached = true
        const detach = session.attach()
        return () => {
          attached = false
          pendingSettlement = false
          detach()
        }
      },
    }
  }
  // Revalidation and version props must not replace a committed owner.
  // Render-local state is rolled back with an abandoned navigation render.
  const [owner, setOwner] = useState(() => ({
    artifactId,
    display: createDisplay(),
  }))
  if (owner.artifactId !== artifactId)
    setOwner({ artifactId, display: createDisplay() })
  const display = owner.display
  const session = display.session
  useLayoutEffect(() => {
    committedSession.current = session
    const unsubscribe = session.subscribe((replaced) => {
      if (!replaced) {
        dispatchComment({ type: 'data-status-changed' })
        return
      }
      const snapshot = session.getSnapshot()
      dispatchComment({
        type: 'threads-replaced',
        threads: snapshot.threads,
        deletedThreadId: snapshot.deletedThreadId,
      })
    })
    const detach = display.attach()
    return () => {
      if (committedSession.current === session) committedSession.current = null
      unsubscribe()
      detach()
    }
  }, [display, session])
  const replaceThreads = useCallback(
    (rows: ReadonlyArray<CommentThreadView>, patch?: CommentThreadPatch) => {
      committedSession.current?.applyMutation(rows, patch)
    },
    [],
  )
  const applyAnchorResolutions = useCallback(
    (results: AnchorResolutionMessage['results']) => {
      committedSession.current?.applyAnchorResults(results)
    },
    [],
  )
  const retryTargetFetch = useCallback(() => {
    committedSession.current?.retryTarget()
  }, [])
  const acceptedTargetId = state.targetThreadId
  useEffect(() => {
    session.ensureTarget()
  }, [session, acceptedTargetId])

  // The socket lifecycle keeps authorization recovery independent from the
  // ordinary comments refresh scheduler.
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    type ConnectionKind = 'ordinary' | 'renewal' | 'bounded'
    type RecoveryCheckCompletion =
      | {
          outcome: 'authorized'
          threads: ReadonlyArray<CommentThreadView>
          capture: CommentRecoveryTicket
        }
      | { outcome: 'denied' | 'indeterminate' | 'cancelled' }
    const ORDINARY_CHECK_AFTER_MS = 60_000
    const ORDINARY_STOP_AFTER_MS = 120_000
    const EXPIRY_CODE = 4401
    const EXPIRY_REASON = 'live-authorization-expired'

    let disposed = false
    let socket: WebSocket | null = null
    let finishSocketAttempt: ReturnType<
      typeof startCommentNetworkOperation
    > | null = null
    let hasOpenedSocket = false
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
    let recoveryController: AbortController | null = null
    let recoveryPromise: Promise<RecoveryCheckCompletion> | null = null
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
      finishSocketAttempt?.(close ? 'abort' : 'network-error')
      finishSocketAttempt = null
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
      void session.requestRefresh().then((result) => {
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
      if (
        disposed ||
        committedSession.current !== session ||
        !isCurrentArtifactId(artifactId)
      )
        return Promise.resolve({ outcome: 'cancelled' })
      if (recoveryPromise) return recoveryPromise
      const controller = new AbortController()
      const capture = session.captureRecovery()
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
            {
              requireJson: true,
              commentDiagnostic: {
                operation: 'recovery',
              },
            },
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
          committedSession.current !== session ||
          sequence !== recoverySequence ||
          !isCurrentArtifactId(artifactId)
        ) {
          return { outcome: 'cancelled' }
        }
        // A same-sequence abort is the ordinary deadline, not supersession.
        if (controller.signal.aborted) return { outcome: 'indeterminate' }
        return completion.outcome === 'authorized'
          ? { ...completion, capture }
          : completion
      })()
      recoveryPromise = currentPromise
      return currentPromise
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
      delay += Math.random() * Math.min(250, delay / 4)
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
        session.retainRecovery(result.capture, result.threads)
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
      const base = Math.min(1000 * 2 ** reconnectAttempt, 30_000)
      let delay = Math.min(
        base + Math.random() * Math.min(250, base / 4),
        30_000,
      )
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
              session.retainRecovery(result.capture, result.threads)
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

      const finishAttempt = startCommentNetworkOperation({
        operation: 'socket',
      })
      finishSocketAttempt = finishAttempt
      let currentSocket: WebSocket
      try {
        currentSocket = new WebSocket(url)
      } catch {
        finishAttempt('network-error')
        handlePreOpenFailure(kind)
        return
      }
      socket = currentSocket
      let opened = false
      let settled = false

      const failBeforeOpen = () => {
        if (socket !== currentSocket || settled) return
        settled = true
        finishAttempt('network-error')
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
        // The first connection's summary must not cancel initial navigation.
        // Later connections reconcile changes missed while the socket was down.
        if (hasOpenedSocket) session.invalidatePages()
        hasOpenedSocket = true
        finishAttempt('success')
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

        const reusedRecovery = session.applyRecovery()
        if (!reusedRecovery) {
          session.markAllDirty()
          session.abortRefresh()
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
          if (!session.remoteChanged(message)) return
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
          session.clearRecovery()
          clearRetryTimer()
          session.abortRefresh()
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

    let reconcileAfterRecovery = false
    const explicitRecovery = (reconcile = false) => {
      if (disposed) return
      reconcileAfterRecovery ||= reconcile
      if (
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
        session.retainRecovery(result.capture, result.threads)
        // HTTP authorization and reconciliation must not depend on WebSocket
        // availability. Reuse the same bounded windows/ranges as socket open.
        if (reconcileAfterRecovery) {
          reconcileAfterRecovery = false
          if (!session.applyRecovery()) {
            session.invalidatePages()
            session.markAllDirty()
            requestCommentRefresh(null)
          }
        }
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
        session.abortRefresh()
        releaseSocket(true)
        clearDisplay()
        return
      }
      if (!socket) explicitRecovery()
    }

    const onMutationSettled = () => {
      if (reconnectStopped && !socket) {
        explicitRecovery(true)
        return
      }
      if (recoveryPromise || session.hasStaleRecovery()) return
      if (session.hasPending()) return
      requestCommentRefresh(socket)
    }

    if (liveEnabled) {
      startSocket('ordinary')
      document.addEventListener('visibilitychange', onVisibilityChange)
    } else {
      onLiveConnectionChangedRef.current?.(false)
    }
    const unsubscribe = display.subscribeSettlement(onMutationSettled)
    const unsubscribePageAuth = display.onPageAuthError(() =>
      requestCommentRefresh(socket),
    )
    return () => {
      disposed = true
      clearRetryTimer()
      clearStableTimer()
      clearHeartbeat()
      cancelRecoveryCheck()
      session.abortRefresh()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      unsubscribe()
      unsubscribePageAuth()
      session.clearRecovery()
      releaseSocket(true)
      clearDisplay()
    }
  }, [
    display,
    session,
    artifactId,
    currentUserId,
    isCurrentArtifactId,
    liveEnabled,
    onLiveConnectionChangedRef,
    onVersionChangedRef,
    onVersionReconcileRef,
    onViewCountChangedRef,
  ])

  return {
    state,
    presence: liveEnabled ? state.presence : emptyPresence,
    totalCount,
    returnFocusRef,
    requestedFilter: requestedFilterRef.current,
    focusTargetOnOpen: state.focusTargetOnOpen,
    pageSession: session,
    targetFetchFailed: session.getSnapshot().failedThreadIds.length > 0,
    retryTargetFetch,
    consumeTargetFocus,
    isCurrentArtifactId,
    openPanel,
    replaceThreads,
    applyAnchorResolutions,
    panelThreads,
    setAnchorCheckingAvailable,
    changePanelOpen,
    targetThread,
    startTextSelection,
    openPendingComposer,
    openInlineThread,
    closeInlinePopover,
    clearPendingTextAnchor,
    clearLocationComments,
  }
}

type LiveMessage =
  | { type: 'presence'; users: ViewerPresence[] }
  | {
      type: 'comments-changed'
      threadId?: string
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
    threadId?: unknown
    originMutationId?: unknown
    originUserId?: unknown
  }
  if (message.type === 'comments-changed') {
    const identity =
      typeof message.threadId === 'string' &&
      message.threadId.length > 0 &&
      message.threadId.length <= 128
        ? { threadId: message.threadId }
        : {}
    return typeof message.originMutationId === 'string' &&
      message.originMutationId.length > 0 &&
      typeof message.originUserId === 'string' &&
      message.originUserId.length > 0
      ? {
          type: message.type,
          ...identity,
          originMutationId: message.originMutationId,
          originUserId: message.originUserId,
        }
      : { type: message.type, ...identity }
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
  lookupUrl: requestedLookupUrl,
  currentVersionId,
  liveAvailable,
}: {
  lookupUrl: string | null
  currentVersionId: string | null
  liveAvailable: boolean
}) {
  const [anonymousLookupDenied, setAnonymousLookupDenied] = useState(false)
  const isAnonymousLookup = requestedLookupUrl?.endsWith('/current-version')
  const lookupUrl =
    isAnonymousLookup && anonymousLookupDenied ? null : requestedLookupUrl
  // Authenticated pointer updates must not reset the polling cadence or cooldown.
  const anonymousVersionId = isAnonymousLookup ? currentVersionId : null
  const lookupUrlRef = useLatestRef(lookupUrl)
  const currentVersionIdRef = useLatestRef(currentVersionId)
  const liveAvailableRef = useLatestRef(liveAvailable)
  const latestCheckSeqRef = useRef(0)
  const latestCheckAbortRef = useRef<AbortController | null>(null)
  const latestCheckKindRef = useRef<LatestVersionCheckKind | null>(null)
  const latestCheckStartedAtRef = useRef(0)
  const latestCheckRetryTimerRef = useRef<number | null>(null)
  const latestCheckRetryKindRef = useRef<LatestVersionCheckKind | null>(null)
  const [notice, setNotice] = useState(() => ({
    lookupUrl,
    currentVersionId,
    hasNewerVersion: false,
  }))

  if (
    notice.currentVersionId !== currentVersionId ||
    notice.lookupUrl !== lookupUrl
  ) {
    setNotice({ lookupUrl, currentVersionId, hasNewerVersion: false })
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
      if (!current || !lookupUrlRef.current) return
      if (nextVersionId !== current) {
        latestCheckSeqRef.current += 1
      }
      setNotice((previous) =>
        previous.currentVersionId === current
          ? { ...previous, hasNewerVersion: nextVersionId !== current }
          : previous,
      )
    },
    [currentVersionIdRef, lookupUrlRef],
  )

  const checkLatestVersion = useCallback(
    async function checkLatestVersion(
      options: { kind: LatestVersionCheckKind } = {
        kind: 'fallback',
      },
    ) {
      const url = lookupUrlRef.current
      if (!url || !currentVersionIdRef.current) return
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
      }>(url, {
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
        if (
          response?.status === 404 &&
          url.endsWith('/current-version') &&
          seq === latestCheckSeqRef.current &&
          url === lookupUrlRef.current &&
          !controller.signal.aborted
        ) {
          // A revoked anonymous link stays disabled until the page is reopened.
          lookupUrlRef.current = null
          latestCheckSeqRef.current += 1
          clearLatestVersionRetry()
          setAnonymousLookupDenied(true)
        }
        return
      }
      const body = result?.body ?? null
      if (typeof body?.currentVersionId !== 'string') return
      if (seq !== latestCheckSeqRef.current || url !== lookupUrlRef.current)
        return
      markVersionChanged(body.currentVersionId)
    },
    [
      lookupUrlRef,
      clearLatestVersionRetry,
      currentVersionIdRef,
      liveAvailableRef,
      markVersionChanged,
    ],
  )

  useEffect(() => {
    latestCheckStartedAtRef.current = 0
  }, [lookupUrl, anonymousVersionId])

  useEffect(() => {
    latestCheckSeqRef.current += 1
    clearLatestVersionRetry()
    abortLatestVersionCheck()
    return () => {
      latestCheckSeqRef.current += 1
      clearLatestVersionRetry()
      abortLatestVersionCheck()
    }
  }, [
    abortLatestVersionCheck,
    lookupUrl,
    currentVersionId,
    clearLatestVersionRetry,
  ])

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
    if (!lookupUrl || liveAvailable) return
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
  }, [checkLatestVersion, liveAvailable, lookupUrl, anonymousVersionId])

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
  const controller = useViewerShellController(props)
  return (
    <PdfPageContext value={controller.pdfPageBridge}>
      <CommentPageSessionContext value={controller.comments.pageSession}>
        <ViewerShellView {...controller} />
      </CommentPageSessionContext>
    </PdfPageContext>
  )
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
  const diagnosticsAccess: 'editor' | 'viewer' =
    user !== null &&
    (artifact.canChangeVisibility === true || artifact.canReplaceFile === true)
      ? 'editor'
      : 'viewer'
  const canReplaceFile = user !== null && artifact.canReplaceFile === true
  const isHistoricalVersion = artifact.isHistoricalVersion === true
  const canReplaceCurrentFile = canReplaceFile && !isHistoricalVersion
  const canViewHistory = artifact.canViewHistory === true
  const replaceMode: 'single' | 'static_site' =
    renderType === 'static_site' ? 'static_site' : 'single'
  const frameTitle = displayTitle(artifact)
  const viewerRef = useRef<HTMLDivElement | null>(null)
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
        hash: latestViewerHash(),
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
    lookupUrl:
      !isHistoricalVersion &&
      artifact.currentVersionId &&
      (user ||
        (artifact.visibility === 'link' &&
          !artifact.linkExpired &&
          !artifact.linkSuspended))
        ? `/api/shareables/${encodeURIComponent(artifact.id)}/${user ? 'versions' : 'current-version'}`
        : null,
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
  const textAnchorsEnabled = viewerTextAnchorsEnabled(
    renderType,
    isHistoricalVersion,
  )
  // static_site で表示中のコメントの場所。別の場所の会話は確認待ちにしない。
  const [commentLocation, setCommentLocation] = useState<string | null>(null)
  // 全体コメントの新規作成 composer は static_site と pdf と video。html / md は本文選択で付ける。
  // pdf / video の本文も別オリジンの iframe にあり、位置・時刻コメントは後続タスク。
  const newThreadComposerEnabled =
    renderType === 'static_site' ||
    renderType === 'pdf' ||
    renderType === 'video'
  // A static site's text comments live on its pages; the panel names the page.
  const commentLocationsShown = renderType === 'static_site'
  // PDFs: the page the viewer shows, on the version it was reported for. A
  // new comment from the panel is placed on it; a page comment opens its page.
  const [shownPdfPage, setShownPdfPage] = useState<PdfCommentPage | null>(null)
  const [pdfOpenRequest, setPdfOpenRequest] = useState<{
    pageNumber: number
    versionId: string | null
  } | null>(null)
  const commentPage = pdfCommentPage(shownPdfPage, {
    renderType,
    isHistoricalVersion,
    currentVersionId: artifact.currentVersionId ?? null,
  })
  const pdfPageBridge = useMemo<PdfPageBridge | null>(
    () =>
      renderType === 'pdf'
        ? {
            page: commentPage,
            onPageChange: (versionId, page) =>
              setShownPdfPage(
                page ? { versionId, pageNumber: page.pageNumber } : null,
              ),
            openRequest: pdfOpenRequest,
            displayedVersionId: artifact.currentVersionId ?? null,
            // The request names the version the card's navigation was
            // decided for; only a frame showing that version moves.
            openPage: (pageNumber, versionId) =>
              setPdfOpenRequest({ pageNumber, versionId }),
          }
        : null,
    [renderType, commentPage, pdfOpenRequest, artifact.currentVersionId],
  )
  const comments = useViewerComments({
    framePresent: Boolean(sandboxUrl),
    artifactId: artifact.id,
    currentUserId: user?.id ?? null,
    currentVersionId: artifact.currentVersionId ?? null,
    initialThreads: initialCommentThreads,
    entryNewCommentMessages: artifact.revisitContext?.newCommentMessages,
    targetCommentId,
    liveEnabled: commentsEnabled,
    onViewCountChanged: handleViewCountChanged,
    onVersionChanged: latestVersion.markVersionChanged,
    onVersionReconcile: latestVersion.reconcile,
    onLiveConnectionChanged: setLiveConnected,
    onPanelOpened: handleCommentsPanelOpened,
    commentLocation: renderType === 'static_site' ? commentLocation : undefined,
  })
  const { clearLocationComments } = comments
  const handleCommentLocationChange = useCallback(
    (location: string | null) => {
      setCommentLocation(location)
      clearLocationComments()
    },
    [clearLocationComments],
  )
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

  const runExportAction = useCallback(
    async (
      action: 'copy' | 'download',
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

  useEffect(() => {
    if (!targetCommentId) return
    const params = new URLSearchParams(routerLocation.search)
    params.delete('comment')
    if (accessRequestId !== null) params.delete('access-request')
    navigate(
      {
        pathname: routerLocation.pathname,
        hash: latestViewerHash(),
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

  const showLatestVersion = () => {
    // The notice button disappears, and the frame remounts on refresh.
    // Keep focus on the viewer that survives both updates.
    if (!canViewHistory) viewerRef.current?.focus({ preventScroll: true })
    latestVersion.clearNewerVersion()
    revalidator.revalidate()
  }

  const displayedBodyVersion =
    artifact.displayedVersionId ?? artifact.currentVersionId
  const bodyHref =
    sandboxUrl &&
    new URL(sandboxUrl).pathname !== DELIVERY_UNAVAILABLE_PATH &&
    (renderType === 'html' ||
      renderType === 'md' ||
      renderType === 'pdf' ||
      renderType === 'video' ||
      renderType === 'static_site') &&
    !linkSafety?.lowTrust &&
    displayedBodyVersion
      ? `/a/${encodeURIComponent(artifact.id)}/body?version=${encodeURIComponent(displayedBodyVersion)}`
      : undefined

  return {
    bodyHref,
    artifact: artifactForChrome,
    viewerRef,
    showLatestVersion,
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
    diagnosticsAccess,
    canReplaceFile: canReplaceCurrentFile,
    canViewHistory,
    isHistoricalVersion,
    exportActions:
      user && !isHistoricalVersion && artifactSupportsExport(renderType)
        ? {
            copyMarkdown: handleCopyMarkdown,
            downloadHtml: handleDownloadHtml,
            downloadMarkdown: handleDownloadMarkdown,
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
    commentLocationsShown,
    pdfPageBridge,
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
    handleCommentLocationChange,
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
  bodyHref,
  artifact,
  viewerRef,
  showLatestVersion,
  user,
  renderType,
  sandboxUrl,
  bundlePaths,
  fallbackToIndex,
  children,
  state,
  dispatch,
  canReplaceFile,
  diagnosticsAccess,
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
  commentLocationsShown,
  replaceMode,
  viewerListAvailable,
  viewerList,
  viewerListReturnFocusRef,
  changeViewerListOpen,
  handleViewerListEntrySelect,
  submitReplaceVersion,
  handleDrop,
  setFrameExportPath,
  handleCommentLocationChange,
  appOrigin,
  analyticsMode,
  linkSafety,
}: ViewerShellController) {
  const { t } = useT()
  const collapseToggleRef = useRef<HTMLButtonElement | null>(null)

  return (
    <div
      ref={viewerRef}
      role="region"
      aria-label={frameTitle}
      tabIndex={-1}
      className="bg-surface-warm fixed inset-x-0 top-0 bottom-[var(--consent-banner-height)] flex flex-col overflow-hidden overscroll-none"
    >
      <ViewerChrome
        bodyHref={bodyHref}
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
          entrypointPath={artifact.entrypointPath}
          renderType={renderType}
          canViewEnvironmentDiagnostics={diagnosticsAccess === 'editor'}
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
          onAnchorResolutions={comments.applyAnchorResolutions}
          onAnchorCheckingChange={comments.setAnchorCheckingAvailable}
          targetThreadId={comments.state.targetThreadId}
          targetRequest={comments.state.targetThreadRequest}
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
          onCommentLocationChange={handleCommentLocationChange}
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
      <VersionWidget
        retention={{
          limit: artifact.retainVersions ?? null,
          publisherManaged: artifact.publisherManaged,
          editable: artifact.canChangeRetention === true,
        }}
        canViewHistory={canViewHistory}
        hidden={state.chromeCollapsed}
        versions={artifact.versions ?? []}
        canReplaceFile={canReplaceFile}
        onSubmit={canReplaceFile ? submitReplaceVersion : undefined}
        replaceMode={replaceMode}
        uploading={state.uploading}
        hasNewerVersion={latestVersion.hasNewerVersion}
        onShowLatest={showLatestVersion}
        onOpenHistory={(returnFocusTo) => {
          historyReturnFocusRef.current = returnFocusTo ?? getActiveElement()
          closeAccessRequests()
          dispatch({ type: 'history-open-changed', open: true })
          comments.changePanelOpen(false)
        }}
        revisitContext={artifact.revisitContext}
        onCommentsOpen={commentsEnabled ? comments.openPanel : undefined}
      />
      {canViewHistory ? (
        <ViewerHistoryPanel
          artifact={artifact}
          state={state}
          dispatch={dispatch}
          canReplaceFile={canReplaceFile}
          submitReplaceVersion={submitReplaceVersion}
          replaceMode={replaceMode}
          closeAccessRequests={closeAccessRequests}
          comments={comments}
          historyReturnFocusRef={historyReturnFocusRef}
          collapseToggleRef={collapseToggleRef}
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
        <ViewerCommentPanel
          artifact={artifact}
          user={user}
          state={state}
          comments={comments}
          newThreadComposerEnabled={newThreadComposerEnabled}
          commentLocationsShown={commentLocationsShown}
          collapsedFallbackRef={collapseToggleRef}
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

function ViewerCommentPanel({
  artifact,
  user,
  state,
  comments,
  newThreadComposerEnabled,
  commentLocationsShown,
  collapsedFallbackRef,
}: Pick<
  ViewerShellController,
  | 'artifact'
  | 'state'
  | 'comments'
  | 'newThreadComposerEnabled'
  | 'commentLocationsShown'
> & {
  user: NonNullable<ViewerShellController['user']>
  collapsedFallbackRef: { current: HTMLButtonElement | null }
}) {
  return (
    <CommentLocationsContext value={commentLocationsShown}>
      <CommentPanel
        key={artifact.id}
        shareableId={artifact.id}
        viewerUserId={user.id}
        threads={comments.panelThreads}
        onThreadsChange={comments.replaceThreads}
        isCurrentShareableId={comments.isCurrentArtifactId}
        open={comments.state.panelOpen}
        onOpenChange={comments.changePanelOpen}
        targetFetchFailed={comments.targetFetchFailed}
        onRetryTarget={comments.retryTargetFetch}
        targetThreadId={comments.state.targetThreadId}
        targetThreadScroll={comments.state.targetThreadScroll}
        onThreadNavigate={(thread) =>
          comments.targetThread(thread.id, { scroll: 'start' })
        }
        returnFocusRef={comments.returnFocusRef}
        collapsedFallbackRef={collapsedFallbackRef}
        requestedFilter={comments.requestedFilter}
        focusTargetOnOpen={comments.focusTargetOnOpen}
        onTargetFocusConsumed={comments.consumeTargetFocus}
        newCommentMessages={artifact.revisitContext?.newCommentMessages}
        topbarCollapsed={state.chromeCollapsed}
        showNewThreadComposer={newThreadComposerEnabled}
      />
    </CommentLocationsContext>
  )
}
