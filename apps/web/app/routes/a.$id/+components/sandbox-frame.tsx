import { parseTextLocus } from '~/lib/csp-reporter'
import {
  createViewerHashSync,
  VIEWER_FRAME_BOOTSTRAP_SCRIPT,
} from '~/lib/viewer-hash'
import { useHydrated } from '~/hooks/use-hydrated'
import { CspBanner } from './csp-banner'
import { reloadViewerPage } from './reload-viewer-page'
import { retainCspViolation } from './csp-violation-retention'
import { classifyCspViolation } from '~/lib/csp-violation-classification'
import { createAnchorResolutionSync } from '~/lib/anchor-resolution-sync'
import type {
  AnchorResolutionMessage,
  CspViolationMessage,
} from '~/lib/csp-reporter'
import { toast } from 'sonner'
import { IconCheck, IconFile, IconPlugConnected } from '@tabler/icons-react'
import {
  use,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react'
import { useViewTransitionState } from 'react-router'
import { useT } from '~/hooks/use-t'
import {
  SANDBOX_READY_CHECK_MESSAGE,
  acceptSandboxToken,
  canUseOsHandler,
  createSandboxChallenge,
  ensureSandboxChallenge,
  type LinkClickedMessage,
  type TextSelectionMessage,
} from '~/lib/csp-reporter'
import { t as translate, tPlural as translatePlural } from '~/lib/i18n'
import {
  APEX_HOST,
  DELIVERY_UNAVAILABLE_PATH,
  SANDBOX_DEV_SUFFIX,
  WWW_HOST,
  sandboxVersionIdentityFromHostname,
} from '~/lib/hosts'
import { withoutSearchParameters } from '~/lib/sandbox-delivery-query'
import {
  SANDBOX_PROBE_MARKER,
  SANDBOX_PROBE_PATH,
} from '~/lib/sandbox-block-report'
import { DeniedPanel } from '~/components/app/denied-panel'
import { Button } from '~/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'
import {
  sandboxExternalLinkPolicyMessage,
  sandboxMessageFromFrame,
} from '~/lib/sandbox-frame-message'
import { DEFAULT_APP_THEME, isAppTheme } from '~/lib/app-theme'
import { viewerPreferencesMessage } from '~/viewers/shared/preferences'
import {
  pdfOpenPageMessage,
  pdfPageSyncMessage,
} from '~/viewers/shared/pdf-page'
import { PdfPageContext } from './pdf-page-context'
import { renderMermaidRequest } from './mermaid-render-request'
import {
  classifyViewerLinkNavigation,
  continueExternalNavigation,
  externalNavigationDestination,
  externalNavigationDecision,
  hasBrowserUserActivation,
  type LinkNavigationMode,
} from '~/lib/viewer-navigation'
import { type CommentThreadView } from '~/lib/comments'
import {
  cfRayFrom,
  fetchJsonWithViewerTimeout,
  logViewerNetworkEvent,
  viewerFetchFailureReason,
} from '~/lib/viewer-network'
import { type PendingTextAnchor } from './viewer-comment-types'
import { normalizeStaticSiteFramePath } from './export-actions'
import {
  commentLocationFromUrl,
  commentLocationHref,
  isCommentLocationServed,
} from '@artifactshare/viewer-kit/reporter/comment-location'
import {
  classifySandboxProbeResponse,
  shouldAttemptAutomaticRecovery,
  shouldAcceptNavigationResult,
  shouldReportBlock,
  shouldStartLivenessCheck,
  shouldStartLivenessProbe,
} from '~/lib/sandbox-frame-state'

function addFrameOffset(
  rect: TextSelectionMessage['rect'],
  frameRect: DOMRect,
): TextSelectionMessage['rect'] {
  return {
    top: rect.top + frameRect.top,
    left: rect.left + frameRect.left,
    width: rect.width,
    height: rect.height,
  }
}

type PendingJump = { threadId: string; location: string }

type SandboxLoadState = 'loading' | 'ready' | 'resuming' | 'blocked' | 'paused'
type CspViolationEntry = CspViolationMessage & { id: string }

// The frame's URL, how far that URL has got, and what it reported are one
// state: every navigation moves all three together. Keeping them in one
// reducer means a navigation is a single dispatch naming what it is, instead
// of three setters whose agreement a reader has to check at each call site.
type FrameState = {
  url: string
  changed: boolean
  loadState: SandboxLoadState
  violations: CspViolationEntry[]
}

type FrameAction =
  // A different document. Its predecessor's violations do not describe it.
  | { type: 'navigate'; url: string }
  // The same document behind a freshly signed URL, so its violations stand.
  | { type: 'reload'; url: string }
  | { type: 'load-state'; loadState: SandboxLoadState }
  | {
      type: 'violations'
      retain: (current: CspViolationEntry[]) => CspViolationEntry[]
    }

// Each case returns the current state unchanged when nothing moved, so React
// bails out of the render exactly where the separate setters used to.
function frameReducer(current: FrameState, action: FrameAction): FrameState {
  switch (action.type) {
    case 'navigate':
      return {
        url: action.url,
        changed: true,
        loadState: 'loading',
        violations: [],
      }
    case 'reload':
      return {
        ...current,
        url: action.url,
        changed: true,
        loadState: 'loading',
      }
    case 'load-state':
      return current.loadState === action.loadState
        ? current
        : { ...current, loadState: action.loadState }
    case 'violations': {
      const violations = action.retain(current.violations)
      return violations === current.violations
        ? current
        : { ...current, violations }
    }
  }
}

type PdfPage = { pageNumber: number; pageCount: number }

type SandboxFrameProps = {
  entrypointPath?: string | null
  renderType: string | null
  canViewEnvironmentDiagnostics: boolean
  shareableId: string
  versionId: string
  url: string
  name: string
  mermaidEnabled: boolean
  textAnchorsEnabled: boolean
  linkNavigationMode: LinkNavigationMode
  bundlePaths: ReadonlyArray<string>
  fallbackToIndex: boolean
  commentThreads: ReadonlyArray<CommentThreadView>
  targetThreadId: string | null
  targetRequest?: number
  highlightThreadId: string | null
  followsAppTheme: boolean
  lowTrust?: boolean
  onAnchorCheckingChange?: (available: boolean) => void
  onAnchorResolutions?: (results: AnchorResolutionMessage['results']) => void
  onTextSelection: (selection: PendingTextAnchor) => void
  onTextSelectionClear: () => void
  onThreadSelect: (threadId: string, rect: TextSelectionMessage['rect']) => void
  onOutsidePointerDown: () => void
  onFramePathChange?: (path: string) => void
  onCommentLocationChange?: (location: string | null) => void
  sandboxPermissions: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads'
  children?: ReactNode
}

export const SANDBOX_FRAME_ALLOW =
  'fullscreen; clipboard-write; language-model; summarizer; translator; language-detector'

const SANDBOX_FRAME_BASE_CLASS_NAME = 'block h-full w-full border-0'
const AUTOMATIC_RECOVERY_ATTEMPT_LIMIT = 1

export const FRAME_READY_CHECK_INTERVAL_MS = 250

export function sandboxFrameSurfaceClassName(followsAppTheme: boolean) {
  return followsAppTheme
    ? `${SANDBOX_FRAME_BASE_CLASS_NAME} bg-background [color-scheme:light_dark] dark:[color-scheme:dark] [[data-theme=light]_&]:[color-scheme:light]`
    : `${SANDBOX_FRAME_BASE_CLASS_NAME} bg-white [color-scheme:light]`
}

export function SandboxFrame(props: SandboxFrameProps) {
  const { t } = useT()
  if (new URL(props.url).pathname === DELIVERY_UNAVAILABLE_PATH) {
    return (
      <ViewerBodySurface>
        <div
          data-sandbox-state="delivery-unavailable"
          className="bg-background relative block h-full w-full overflow-hidden"
        >
          <div className="absolute inset-0 overflow-y-auto">
            <DeniedPanel
              icon={<IconFile aria-hidden="true" />}
              title={t('vw.deliveryUnavailable.title')}
              body={t('vw.deliveryUnavailable.body')}
              actions={
                <Button size="sm" onClick={reloadViewerPage}>
                  {t('vw.deliveryUnavailable.reload')}
                </Button>
              }
            />
            <span className="sr-only" role="status" aria-live="polite">
              {t('vw.deliveryUnavailable.title')}
            </span>
          </div>
        </div>
        {props.children}
      </ViewerBodySurface>
    )
  }
  return <ActiveSandboxFrame {...props} />
}

function ActiveSandboxFrame(props: SandboxFrameProps) {
  const { shareableId, name, sandboxPermissions, children } = props
  const controller = useSandboxFrameController(props)
  const hydrated = useHydrated()
  const [clientMounted] = useState(hydrated)
  const frameSrc =
    clientMounted || controller.frameSourceChanged
      ? controller.frameUrl
      : undefined
  const sandboxOrigin = new URL(controller.frameUrl).origin
  const visibleViolations = controller.violations.flatMap((violation) => {
    const classification = classifyCspViolation(
      violation.sourceFile,
      sandboxOrigin,
      props.renderType,
      violation.blockedURI,
    )
    return classification === 'artifact' || props.canViewEnvironmentDiagnostics
      ? [{ ...violation, classification }]
      : []
  })

  return (
    <ViewerBodySurface>
      <div
        data-sandbox-state={controller.loadState}
        className="bg-background relative block h-full w-full overflow-hidden"
        style={{
          viewTransitionName: controller.isTransitioning
            ? `artifact-${shareableId}-surface`
            : 'none',
        }}
      >
        {controller.loadState !== 'ready' &&
        controller.loadState !== 'loading' ? (
          <div className="absolute inset-0 z-10 overflow-y-auto">
            <SandboxState controller={controller} />
          </div>
        ) : null}
        <iframe
          key={controller.frameInstance}
          ref={controller.frameRef}
          title={name}
          data-src={controller.frameUrl.split('#')[0]}
          src={frameSrc}
          suppressHydrationWarning
          allow={SANDBOX_FRAME_ALLOW}
          sandbox={sandboxPermissions}
          referrerPolicy="no-referrer"
          className={`${sandboxFrameSurfaceClassName(props.followsAppTheme)} ${controller.loadState !== 'ready' && controller.loadState !== 'loading' ? 'hidden' : ''}`}
          onLoad={controller.handleFrameLoad}
        />
        <script
          dangerouslySetInnerHTML={{
            __html: VIEWER_FRAME_BOOTSTRAP_SCRIPT,
          }}
        />
        <noscript>
          <iframe
            title={name}
            src={props.url.split('#')[0]}
            allow={SANDBOX_FRAME_ALLOW}
            sandbox={sandboxPermissions}
            referrerPolicy="no-referrer"
            className={`absolute inset-0 z-10 ${sandboxFrameSurfaceClassName(props.followsAppTheme)}`}
          />
        </noscript>
        {controller.loadState === 'loading' ? <FrameLoading /> : null}
      </div>
      {children}
      {visibleViolations.length > 0 && (
        <CspBanner violations={visibleViolations} />
      )}
      <ExternalLinkInterstitial
        action={controller.pendingExternalNavigation}
        onCancel={controller.cancelExternalNavigation}
        onContinue={controller.continueExternalNavigation}
      />
    </ViewerBodySurface>
  )
}

function ExternalLinkInterstitial({
  action,
  onCancel,
  onContinue,
}: {
  action: Extract<
    ReturnType<typeof classifyViewerLinkNavigation>,
    { kind: 'open-external' }
  > | null
  onCancel: () => void
  onContinue: () => void
}) {
  const { t } = useT()
  const destination = action ? externalNavigationDestination(action.url) : ''
  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t('vw.externalLink.title')}</DialogTitle>
          <DialogDescription className="break-all">
            {t('vw.externalLink.destination', { hostname: destination })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t('vw.externalLink.cancel')}
          </Button>
          <Button onClick={onContinue}>{t('vw.externalLink.continue')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ViewerBodySurface(props: ComponentProps<'main'>) {
  return (
    <main
      data-gap-audit-allow-touch
      className="bg-surface-warm relative min-h-0 flex-auto overflow-hidden overscroll-none"
      {...props}
    />
  )
}

function SandboxState({
  controller,
}: {
  controller: ReturnType<typeof useSandboxFrameController>
}) {
  const { t } = useT()
  if (controller.loadState === 'blocked') {
    return (
      <div className="absolute inset-0 overflow-y-auto">
        <DeniedPanel
          icon={<IconPlugConnected aria-hidden="true" />}
          title={t('vw.sandboxBlocked.title')}
          body={
            <>
              <p>{t('vw.sandboxBlocked.body')}</p>
              <p className="text-foreground mt-2 flex items-center justify-center gap-1.5 font-medium">
                <IconCheck aria-hidden="true" size={16} />
                {t('vw.sandboxBlocked.reassurance')}
              </p>
            </>
          }
          actions={
            <>
              <Button
                size="sm"
                ref={controller.primaryActionRef}
                onClick={controller.retry}
              >
                {t('vw.sandboxBlocked.reload')}
              </Button>
              <p>{t('vw.sandboxBlocked.next')}</p>
              <details>
                <summary>{t('vw.sandboxBlocked.company')}</summary>
                <p className="mt-2">{t('vw.sandboxBlocked.admin')}</p>
              </details>
            </>
          }
        />
        <span className="sr-only" role="status" aria-live="polite">
          {t('vw.sandboxBlocked.title')}
        </span>
      </div>
    )
  }
  if (controller.loadState === 'paused') {
    return (
      <div className="absolute inset-0 overflow-y-auto">
        <DeniedPanel
          icon={<IconFile aria-hidden="true" />}
          title={t('vw.sandboxPaused.title')}
          body={
            <>
              <p>{t('vw.sandboxPaused.body')}</p>
              <p className="text-foreground mt-2 flex items-center justify-center gap-1.5 font-medium">
                <IconCheck aria-hidden="true" size={16} />
                {t('vw.sandboxPaused.reassurance')}
              </p>
            </>
          }
          actions={
            <>
              <Button
                size="sm"
                ref={controller.primaryActionRef}
                onClick={controller.retry}
                aria-describedby="sandbox-paused-guidance"
              >
                {t('vw.sandboxPaused.resume')}
              </Button>
              <p id="sandbox-paused-guidance">
                {t(
                  controller.retryFailed
                    ? 'vw.sandboxPaused.retryFailed'
                    : 'vw.sandboxPaused.next',
                )}
              </p>
            </>
          }
        />
        <span className="sr-only" role="status" aria-live="polite">
          {t('vw.sandboxPaused.title')}
        </span>
      </div>
    )
  }
  if (controller.loadState === 'resuming')
    return (
      <output
        aria-live="polite"
        className="text-muted-foreground absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm"
      >
        <div
          className="border-divider border-t-link size-6 animate-spin rounded-full border-2"
          aria-hidden="true"
        />
        {t('vw.sandboxResuming')}
      </output>
    )
  return null
}

function useSandboxFrameController({
  renderType,
  entrypointPath,
  shareableId,
  versionId,
  url,
  name,
  mermaidEnabled,
  textAnchorsEnabled,
  linkNavigationMode,
  bundlePaths,
  fallbackToIndex,
  commentThreads,
  targetThreadId,
  targetRequest = 0,
  highlightThreadId,
  onTextSelection,
  onAnchorResolutions,
  onAnchorCheckingChange,
  onTextSelectionClear,
  onThreadSelect,
  onOutsidePointerDown,
  onFramePathChange,
  onCommentLocationChange,
  sandboxPermissions,
  lowTrust = false,
}: SandboxFrameProps) {
  const { locale, t } = useT()
  const [retryFailed, setRetryFailed] = useState(false)
  const [pendingExternalNavigation, setPendingExternalNavigation] =
    useState<Extract<
      ReturnType<typeof classifyViewerLinkNavigation>,
      { kind: 'open-external' }
    > | null>(null)
  const [frameState, dispatchFrame] = useReducer(
    frameReducer,
    url,
    (initial): FrameState => ({
      url:
        initial + (typeof window === 'undefined' ? '' : window.location.hash),
      changed: false,
      loadState: 'loading',
      violations: [],
    }),
  )
  const { url: frameUrl, loadState, violations } = frameState
  const [probeCycle, restartProbeCycle] = useReducer(
    (current: number) => current + 1,
    0,
  )
  const [frameInstance, restartFrameInstance] = useReducer(
    (current: number) => current + 1,
    0,
  )
  const isTransitioning = useViewTransitionState(`/a/${shareableId}`)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const wasTransitioningRef = useRef(false)
  const [staticSiteAuthRef] = useState(() => ({ current: Date.now() }))
  const frameNavigationIdRef = useRef(0)
  const frameDestinationRef = useRef(0)
  const jumpGenerationRef = useRef(0)
  const supersedePendingDestination = () => {
    frameDestinationRef.current += 1
    jumpGenerationRef.current += 1
  }
  const pendingJumpRef = useRef<PendingJump | null>(null)
  const markJumpUnavailable = useEffectEvent((threadId: string) => {
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent
    onAnchorResolutions?.([
      {
        threadId,
        state: 'needs-check',
        textStart: null,
        textEnd: null,
        textHash: null,
      },
    ])
  })
  const automaticRecoveryAttemptsRef = useRef(0)
  const reportedGenerationRef = useRef<number | null>(null)
  const reportTimerRef = useRef<number | null>(null)
  const primaryActionRef = useRef<HTMLButtonElement>(null)
  const focusRetryFailureRef = useRef(false)
  const securityChallengeRef = useRef<string | null>(null)
  const securityTokenRef = useRef<string | null>(null)
  const [hashSync] = useState(createViewerHashSync)
  useEffect(() => () => hashSync.clear(), [hashSync])
  const mermaidRenderChallengeRef = useRef<string | null>(null)
  const trustedMessageOrigin = new URL(frameUrl).origin
  const pdfBridge = use(PdfPageContext)
  const pdfBridgeRef = useRef(pdfBridge)
  useLayoutEffect(() => {
    pdfBridgeRef.current = pdfBridge
  })
  const pdfPageRef = useRef<PdfPage | null>(null)
  const pdfPageTokenRef = useRef<string | null>(null)
  const setPdfPage = useCallback(
    (page: PdfPage | null) => {
      const current = pdfPageRef.current
      if (
        current?.pageNumber === page?.pageNumber &&
        current?.pageCount === page?.pageCount
      )
        return
      pdfPageRef.current = page
      pdfBridgeRef.current?.onPageChange(versionId, page)
    },
    [versionId],
  )
  const pdfOpenPage = pdfBridge?.openRequest ?? null
  const commentLabels = useMemo(
    () => ({
      openOne: translatePlural(locale, 'comments.highlightOpen', 1),
      openOther: translate(locale, 'comments.highlightOpenOther', { n: '{n}' }),
      resolvedOne: translatePlural(locale, 'comments.highlightResolved', 1),
      resolvedOther: translate(locale, 'comments.highlightResolvedOther', {
        n: '{n}',
      }),
    }),
    [locale],
  )
  const locationScoped = renderType === 'static_site'
  const servedFiles = useMemo(() => new Set(bundlePaths), [bundlePaths])
  const servedLocation = useCallback(
    (location: string | null) =>
      location &&
      isCommentLocationServed(location, servedFiles, fallbackToIndex)
        ? location
        : null,
    [servedFiles, fallbackToIndex],
  )
  const [reportedLocation, setReportedLocation] = useState<{
    frameUrl: string
    frameInstance: number
    location: string | null
  } | null>(null)
  const commentLocation = useMemo(() => {
    if (!locationScoped)
      return normalizeStaticSiteFramePath(new URL(frameUrl).pathname)
    if (
      reportedLocation?.frameUrl === frameUrl &&
      reportedLocation.frameInstance === frameInstance
    )
      return reportedLocation.location
    const parsed = new URL(frameUrl)
    return servedLocation(
      commentLocationFromUrl(parsed.pathname, parsed.hash, fallbackToIndex),
    )
  }, [
    locationScoped,
    frameUrl,
    frameInstance,
    reportedLocation,
    servedLocation,
    fallbackToIndex,
  ])
  const recoveryDestinationRef = useRef(frameUrl)
  useLayoutEffect(() => {
    const parsed = new URL(frameUrl)
    const href =
      locationScoped &&
      commentLocation &&
      commentLocation !==
        commentLocationFromUrl(parsed.pathname, parsed.hash, fallbackToIndex)
        ? commentLocationHref(commentLocation, fallbackToIndex)
        : null
    recoveryDestinationRef.current = href
      ? new URL(href, parsed.origin).href
      : frameUrl
  }, [locationScoped, commentLocation, frameUrl, fallbackToIndex])
  const parentLocationRef = useRef<string | null | undefined>(undefined)
  const highlights = useMemo(() => {
    const textHighlights = commentThreads.flatMap((thread) => {
      const subject = thread.subject
      if (subject.kind !== 'text') return []
      if (locationScoped && subject.targetPath !== commentLocation) return []
      return {
        ...subject,
        threadId: thread.id,
        status: thread.status,
        target: thread.id === highlightThreadId,
        count: thread.messageCount,
      }
    })
    return textHighlights
  }, [commentThreads, highlightThreadId, locationScoped, commentLocation])
  const resolutionSyncRef = useRef<ReturnType<
    typeof createAnchorResolutionSync
  > | null>(null)
  const applyResolutions = useEffectEvent(
    (results: AnchorResolutionMessage['results']) => {
      onAnchorResolutions?.(results)
    },
  )
  useEffect(() => {
    const sync = createAnchorResolutionSync(
      `/api/shareables/${encodeURIComponent(shareableId)}/comments`,
      (results) => applyResolutions(results),
    )
    resolutionSyncRef.current = sync
    return () => {
      sync.dispose()
      resolutionSyncRef.current = null
    }
  }, [shareableId, versionId, frameUrl, frameInstance, commentLocation])
  useEffect(() => {
    resolutionSyncRef.current?.reapply()
  }, [commentThreads])
  const handleAnchorResolutions = useEffectEvent(
    (message: AnchorResolutionMessage) => {
      if (
        message.token !== securityTokenRef.current ||
        message.versionId !== versionId ||
        !commentLocation ||
        message.targetPath !== commentLocation
      )
        return
      const scoped = locationScoped
        ? {
            ...message,
            results: message.results.filter((result) =>
              commentThreads.some(
                (thread) =>
                  thread.id === result.threadId &&
                  thread.subject.kind === 'text' &&
                  thread.subject.targetPath === commentLocation,
              ),
            ),
          }
        : message
      const jump = pendingJumpRef.current
      if (
        jump?.location === message.targetPath &&
        scoped.results.some(
          (result) =>
            result.threadId === jump.threadId && result.state !== 'checking',
        )
      )
        pendingJumpRef.current = null
      resolutionSyncRef.current?.accept(scoped)
    },
  )

  const reportBlock = useCallback(
    (failureType: 'forbidden' | 'network-error' | 'timeout') => {
      const generation = frameNavigationIdRef.current
      if (!shouldReportBlock(reportedGenerationRef.current, generation)) return
      const timer = window.setTimeout(() => {
        reportTimerRef.current = null
        if (generation !== frameNavigationIdRef.current) return
        if (!shouldReportBlock(reportedGenerationRef.current, generation))
          return
        reportedGenerationRef.current = generation
        void fetch(
          `/api/shareables/${encodeURIComponent(shareableId)}/sandbox-block-report`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              artifactId: shareableId,
              failureType,
              confirmedAt: new Date().toISOString(),
            }),
          },
        ).catch(() => undefined)
      }, 50)
      reportTimerRef.current = timer
    },
    [shareableId],
  )

  const probe = useCallback(
    async (generation: number) => {
      const origin = new URL(frameUrl).origin
      const controller = new AbortController()
      const timeout = window.setTimeout(() => controller.abort(), 3000)
      try {
        const response = await fetch(origin + SANDBOX_PROBE_PATH, {
          credentials: 'omit',
          signal: controller.signal,
        })
        const marker = response.headers.get('X-ArtifactShare-Sandbox-Probe')
        const body = response.ok ? await response.text() : ''
        if (
          !shouldAcceptNavigationResult(
            generation,
            frameNavigationIdRef.current,
          )
        )
          return
        const outcome = classifySandboxProbeResponse(
          response.status,
          marker,
          body,
          SANDBOX_PROBE_MARKER,
        )
        if (outcome === 'reachable') {
          if (
            !shouldAttemptAutomaticRecovery(
              automaticRecoveryAttemptsRef.current,
              AUTOMATIC_RECOVERY_ATTEMPT_LIMIT,
            )
          ) {
            if (focusRetryFailureRef.current) setRetryFailed(true)
            dispatchFrame({ type: 'load-state', loadState: 'paused' })
            return
          }
          automaticRecoveryAttemptsRef.current += 1
          frameDestinationRef.current += 1
          dispatchFrame({ type: 'load-state', loadState: 'resuming' })
          const next = await refreshSandboxFrameUrl(
            shareableId,
            versionId,
            frameUrl,
            {
              getHash: hashSync.latest,
              getTargetUrl: () => recoveryDestinationRef.current,
            },
          )
          if (
            !shouldAcceptNavigationResult(
              generation,
              frameNavigationIdRef.current,
            )
          )
            return
          if (next) {
            dispatchFrame({ type: 'reload', url: next })
            restartFrameInstance()
          } else {
            if (focusRetryFailureRef.current) setRetryFailed(true)
            dispatchFrame({ type: 'load-state', loadState: 'paused' })
          }
        } else if (outcome === 'forbidden') {
          dispatchFrame({ type: 'load-state', loadState: 'blocked' })
          reportBlock('forbidden')
        } else {
          dispatchFrame({ type: 'load-state', loadState: 'blocked' })
          reportBlock('network-error')
        }
      } catch (error) {
        if (
          !shouldAcceptNavigationResult(
            generation,
            frameNavigationIdRef.current,
          )
        )
          return
        dispatchFrame({ type: 'load-state', loadState: 'blocked' })
        reportBlock(
          error instanceof DOMException && error.name === 'AbortError'
            ? 'timeout'
            : 'network-error',
        )
      } finally {
        window.clearTimeout(timeout)
      }
    },
    [frameUrl, hashSync, reportBlock, shareableId, versionId],
  )

  const markFrameReadyFromMessage = useEffectEvent(() => {
    if (reportTimerRef.current !== null) {
      window.clearTimeout(reportTimerRef.current)
      reportTimerRef.current = null
    }
    const generation = frameNavigationIdRef.current + 1
    frameNavigationIdRef.current = generation
    automaticRecoveryAttemptsRef.current = 0
    setRetryFailed(false)
    dispatchFrame({ type: 'load-state', loadState: 'ready' })
    if (focusRetryFailureRef.current) {
      focusRetryFailureRef.current = false
      focusFrame()
    }
    frameAnsweredRef.current = true
    offerInitialFocus()
  })
  const handleTextSelectionMessage = useEffectEvent(
    (message: TextSelectionMessage) => {
      if (
        message.selectorFormat &&
        (message.token !== securityTokenRef.current ||
          message.versionId !== versionId)
      )
        return
      if (
        locationScoped &&
        (!message.selectorFormat ||
          !commentLocation ||
          message.targetPath !== commentLocation)
      )
        return
      const frameRect = frameRef.current?.getBoundingClientRect()
      onTextSelection({
        ...(locationScoped ? { targetPath: commentLocation } : {}),
        selectorFormat: message.selectorFormat,
        textHash: message.textHash,
        locus: parseTextLocus(message.locus),
        ambiguousAtCreation: message.ambiguousAtCreation,
        versionId: message.versionId,
        quotedText: message.quotedText,
        prefixText: message.prefixText,
        suffixText: message.suffixText,
        textStart: message.textStart,
        textEnd: message.textEnd,
        cssPath: message.cssPath,
        rect: frameRect
          ? addFrameOffset(message.rect, frameRect)
          : message.rect,
      })
    },
  )
  const handleThreadSelectedMessage = useEffectEvent(
    (threadId: string, rect: TextSelectionMessage['rect']) => {
      const frameRect = frameRef.current?.getBoundingClientRect()
      supersedePendingDestination()
      pendingJumpRef.current = null
      onThreadSelect(
        threadId,
        frameRect ? addFrameOffset(rect, frameRect) : rect,
      )
    },
  )
  const handleOutsidePointerDownMessage = useEffectEvent(() => {
    onOutsidePointerDown()
  })
  const handleTextSelectionClearedMessage = useEffectEvent(() => {
    onTextSelectionClear()
  })
  const navigateFrame = useEffectEvent(
    (
      destination: string,
      isCurrent: () => boolean = () => true,
      jump: PendingJump | null = null,
    ) => {
      pendingJumpRef.current = null
      onFramePathChange?.(
        normalizeStaticSiteFramePath(new URL(destination).pathname),
      )
      frameNavigationIdRef.current += 1
      const destinationId = (frameDestinationRef.current += 1)
      automaticRecoveryAttemptsRef.current = 0
      const lastStaticSiteAuthAt = staticSiteAuthRef.current ?? Date.now()
      const needsRefresh = Date.now() - lastStaticSiteAuthAt > 9 * 60 * 1000
      if (!needsRefresh) {
        securityTokenRef.current = null
        hashSync.flush()
        securityChallengeRef.current = createSandboxChallenge()
        pendingJumpRef.current = jump
        dispatchFrame({ type: 'navigate', url: destination })
        // The same src would not navigate a document that moved away from it
        // through history; load it again.
        if (destination === frameUrl) restartFrameInstance()
        return
      }
      void refreshSandboxFrameUrl(shareableId, versionId, destination, {
        navigation: true,
      }).then((nextFrameUrl) => {
        if (destinationId !== frameDestinationRef.current || !isCurrent())
          return
        if (!nextFrameUrl) {
          toast(t('toast.linkRecoveryFailed'))
          return
        }
        securityTokenRef.current = null
        hashSync.flush()
        securityChallengeRef.current = createSandboxChallenge()
        staticSiteAuthRef.current = Date.now()
        pendingJumpRef.current = jump
        dispatchFrame({ type: 'navigate', url: nextFrameUrl })
      })
    },
  )
  const handleLinkClickedMessage = useEffectEvent(
    (message: LinkClickedMessage) => {
      const action = classifyViewerLinkNavigation({
        href: message.href,
        appOrigin: window.location.origin,
        appHosts: [APEX_HOST, WWW_HOST],
        sandboxOrigin: trustedMessageOrigin,
        bundlePaths,
        fallbackToIndex,
        mode: linkNavigationMode,
      })
      if (action.kind === 'allow-frame') {
        navigateFrame(action.url)
      } else if (action.kind === 'open-app') {
        window.open(action.url, '_blank', 'noopener,noreferrer')
      } else if (action.kind === 'open-external') {
        if (action.disposition === 'os-handler') {
          if (
            !canUseOsHandler(
              securityTokenRef.current,
              message.token,
              hasBrowserUserActivation(window.navigator.userActivation),
            )
          ) {
            toast(t('toast.linkBlocked'))
            return
          }
        }
        if (externalNavigationDecision(action, lowTrust) === 'interstitial') {
          setPendingExternalNavigation(action)
          return
        }
        if (action.disposition === 'os-handler') {
          window.location.href = action.url
          return
        }
        window.open(action.url, '_blank', 'noopener,noreferrer')
      } else if (action.kind === 'unavailable-in-document') {
        toast(t('toast.linkUnavailableInDocument'))
      } else {
        toast(t('toast.linkBlocked'))
      }
    },
  )

  const requestFrameReady = useCallback(() => {
    const challenge = ensureSandboxChallenge(securityChallengeRef.current)
    securityChallengeRef.current = challenge
    // ready-check response は表示監視の liveness signal でもある。ready-check は非機密の確認メッセージ。soft navigation 直後の初期
    // about:blank に sandbox origin 指定で送ると Chrome が mismatch を
    // console に出すため、親から子への送信だけ targetOrigin を広くする。
    frameRef.current?.contentWindow?.postMessage(
      {
        ...SANDBOX_READY_CHECK_MESSAGE,
        challenge,
        versionId,
        targetPath: commentLocation,
        locationScoped,
        fallbackToIndex,
        textAnchorsEnabled,
        commentLabels,
      },
      '*',
    )
  }, [
    commentLabels,
    textAnchorsEnabled,
    versionId,
    commentLocation,
    locationScoped,
    fallbackToIndex,
  ])

  const sendHighlights = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'comment-highlights',
        versionId,
        targetPath: commentLocation,
        locationScoped,
        fallbackToIndex,
        textAnchorsEnabled,
        commentLabels,
        highlights,
      },
      trustedMessageOrigin,
    )
  }, [
    commentLabels,
    highlights,
    textAnchorsEnabled,
    trustedMessageOrigin,
    versionId,
    commentLocation,
    locationScoped,
    fallbackToIndex,
  ])

  const showsViewerPreferences = renderType === 'pdf' || renderType === 'video'
  const sendViewerPreferences = useCallback(() => {
    if (!showsViewerPreferences) return
    const theme = document.documentElement.dataset.theme
    frameRef.current?.contentWindow?.postMessage(
      viewerPreferencesMessage({
        locale,
        theme: isAppTheme(theme) ? theme : DEFAULT_APP_THEME,
      }),
      trustedMessageOrigin,
    )
  }, [locale, showsViewerPreferences, trustedMessageOrigin])

  const initialFocusRef = useRef<'pending' | 'settled'>(
    targetThreadId ? 'settled' : 'pending',
  )
  const readerActedRef = useRef(false)
  const frameAnsweredRef = useRef(false)
  const offerInitialFocus = useEffectEvent(() => {
    if (initialFocusRef.current === 'settled' || !frameAnsweredRef.current)
      return
    if (document.visibilityState !== 'visible') return
    initialFocusRef.current = 'settled'
    if (readerActedRef.current) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    // A task, not an animation frame: a page that is not painting yet still
    // receives the focus, and the same guard keeps a control chosen meanwhile.
    window.setTimeout(() => {
      if (readerActedRef.current) return
      const active = document.activeElement
      if (active !== document.body && active !== frameRef.current) return
      frameRef.current?.focus({ preventScroll: true })
    }, 0)
  })
  useEffect(() => {
    const acted = (event: Event) => {
      if (event.target === frameRef.current) return
      readerActedRef.current = true
    }
    const shown = () => offerInitialFocus()
    window.addEventListener('pointerdown', acted, true)
    window.addEventListener('keydown', acted, true)
    document.addEventListener('focusin', acted, true)
    document.addEventListener('visibilitychange', shown)
    return () => {
      window.removeEventListener('pointerdown', acted, true)
      window.removeEventListener('keydown', acted, true)
      document.removeEventListener('focusin', acted, true)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [])

  const focusFrame = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active !== document.body && active !== frameRef.current) return
      frameRef.current?.focus({ preventScroll: true })
    })
  }, [])

  const handleFrameLoad = useCallback(() => {
    frameAnsweredRef.current = false
    securityChallengeRef.current = createSandboxChallenge()
    securityTokenRef.current = null
    pdfPageTokenRef.current = null
    setPdfPage(null)
    hashSync.flush()
    setPendingExternalNavigation(null)
    mermaidRenderChallengeRef.current = null
    requestFrameReady()
    sendHighlights()
  }, [hashSync, requestFrameReady, sendHighlights, setPdfPage])

  const handleFrameMessage = useEffectEvent((event: MessageEvent) => {
    const message = sandboxMessageFromFrame(
      event,
      trustedMessageOrigin,
      frameRef.current?.contentWindow,
    )
    if (!message) return
    if (message.kind === 'pdf-page-changed') {
      if (
        renderType !== 'pdf' ||
        !pdfPageTokenRef.current ||
        message.token !== pdfPageTokenRef.current
      )
        return
      setPdfPage(
        message.state === 'ready'
          ? { pageNumber: message.pageNumber, pageCount: message.pageCount }
          : null,
      )
    } else if (message.kind === 'csp-violation') {
      const entry = { ...message, id: crypto.randomUUID() }
      dispatchFrame({
        type: 'violations',
        retain: (current) =>
          retainCspViolation(current, entry, trustedMessageOrigin, renderType),
      })
    } else if (message.kind === 'ready') {
      securityTokenRef.current = acceptSandboxToken(
        securityTokenRef.current,
        securityChallengeRef.current,
        message.challenge,
        message.token,
      )
      frameRef.current?.contentWindow?.postMessage(
        sandboxExternalLinkPolicyMessage(lowTrust ? 'parent' : 'direct'),
        trustedMessageOrigin,
      )
      sendViewerPreferences()
      if (renderType === 'pdf') {
        pdfPageTokenRef.current = createSandboxChallenge()
        frameRef.current?.contentWindow?.postMessage(
          pdfPageSyncMessage(pdfPageTokenRef.current),
          trustedMessageOrigin,
        )
      }
      markFrameReadyFromMessage()
    } else if (message.kind === 'hash-changed') {
      if (
        !securityTokenRef.current ||
        message.token !== securityTokenRef.current
      )
        return
      if (locationScoped) {
        const location = servedLocation(
          commentLocationFromUrl(message.path, message.hash, fallbackToIndex),
        )
        setReportedLocation((current) =>
          current?.frameUrl === frameUrl &&
          current.frameInstance === frameInstance &&
          current.location === location
            ? current
            : { frameUrl, frameInstance, location },
        )
        const jump = pendingJumpRef.current
        if (jump && jump.location !== location) {
          pendingJumpRef.current = null
          markJumpUnavailable(jump.threadId)
        }
        if (parentLocationRef.current !== location) {
          if (parentLocationRef.current !== undefined)
            supersedePendingDestination()
          parentLocationRef.current = location
          onCommentLocationChange?.(location)
        }
      }
      if (
        renderType === 'static_site' &&
        normalizeStaticSiteFramePath(message.path) !==
          normalizeStaticSiteFramePath(entrypointPath ?? '/index.html')
      )
        return
      hashSync.accept(message.hash)
    } else if (message.kind === 'anchor-resolutions') {
      handleAnchorResolutions(message)
    } else if (message.kind === 'text-selection') {
      handleTextSelectionMessage(message)
    } else if (message.kind === 'text-selection-cleared') {
      handleTextSelectionClearedMessage()
    } else if (message.kind === 'comment-thread-selected') {
      handleThreadSelectedMessage(message.threadId, message.rect)
    } else if (message.kind === 'comment-outside-pointer-down') {
      handleOutsidePointerDownMessage()
    } else if (message.kind === 'link-clicked') {
      handleLinkClickedMessage(message)
    } else if (message.kind === 'mermaid-render-request') {
      if (
        !mermaidEnabled ||
        message.renderToken !== securityChallengeRef.current ||
        mermaidRenderChallengeRef.current === message.renderToken
      ) {
        return
      }
      mermaidRenderChallengeRef.current = message.renderToken
      const sourceWindow = event.source
      void renderMermaidRequest(message).then((results) => {
        const frameWindow = frameRef.current?.contentWindow
        if (
          !frameWindow ||
          results.length === 0 ||
          sourceWindow !== frameWindow
        ) {
          return
        }
        frameWindow.postMessage(
          {
            source: 'artifactshare-parent',
            kind: 'mermaid-rendered',
            renderToken: message.renderToken,
            results,
          },
          trustedMessageOrigin,
        )
      })
    }
  })
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => handleFrameMessage(event)
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  const reportAnchorChecking = useEffectEvent((available: boolean) => {
    onAnchorCheckingChange?.(available)
  })
  const anchorCheckingWindow = useRef<{ url: string; deadline: number } | null>(
    null,
  )
  useEffect(() => {
    if (anchorCheckingWindow.current?.url !== url) {
      anchorCheckingWindow.current = { url, deadline: Date.now() + 3000 }
    }
    let timer: number | undefined
    const remaining = anchorCheckingWindow.current.deadline - Date.now()
    if (loadState === 'blocked' || loadState === 'paused') {
      reportAnchorChecking(false)
    } else if (loadState === 'ready') {
      reportAnchorChecking(true)
    } else {
      reportAnchorChecking(remaining > 0)
      if (remaining > 0) {
        timer = window.setTimeout(() => reportAnchorChecking(false), remaining)
      }
    }
    return () => {
      window.clearTimeout(timer)
      reportAnchorChecking(false)
    }
  }, [loadState, url])

  useEffect(() => {
    if (loadState !== 'ready') return
    sendHighlights()
  }, [loadState, sendHighlights])

  useEffect(() => {
    if (!showsViewerPreferences || loadState !== 'ready') return
    sendViewerPreferences()
    const observer = new MutationObserver(sendViewerPreferences)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    })
    return () => observer.disconnect()
  }, [loadState, showsViewerPreferences, sendViewerPreferences])

  useEffect(() => {
    if (loadState !== 'ready') setPdfPage(null)
  }, [loadState, setPdfPage])
  useEffect(() => () => setPdfPage(null), [setPdfPage])

  const handledPdfOpenRef = useRef(pdfOpenPage)
  useEffect(() => {
    if (!pdfOpenPage || handledPdfOpenRef.current === pdfOpenPage) return
    handledPdfOpenRef.current = pdfOpenPage
    const shown = pdfPageRef.current
    if (
      renderType !== 'pdf' ||
      loadState !== 'ready' ||
      !shown ||
      pdfOpenPage.versionId !== versionId ||
      pdfOpenPage.pageNumber > shown.pageCount
    )
      return
    frameRef.current?.contentWindow?.postMessage(
      pdfOpenPageMessage(pdfOpenPage.pageNumber),
      trustedMessageOrigin,
    )
  }, [pdfOpenPage, renderType, loadState, trustedMessageOrigin, versionId])

  useEffect(() => {
    if (
      (loadState !== 'blocked' && loadState !== 'paused') ||
      !focusRetryFailureRef.current
    )
      return
    focusRetryFailureRef.current = false
    requestAnimationFrame(() => {
      primaryActionRef.current?.focus({ preventScroll: true })
    })
  }, [loadState])

  const targetLocation = useMemo(() => {
    if (!locationScoped || !targetThreadId) return null
    const thread = commentThreads.find((item) => item.id === targetThreadId)
    return thread?.subject.kind === 'text' ? thread.subject.targetPath : null
  }, [locationScoped, targetThreadId, commentThreads])
  const jumpRequestRef = useRef<string | null>(null)
  useEffect(() => {
    const request =
      targetThreadId && targetLocation
        ? `${targetRequest}\n${targetThreadId}\n${targetLocation}`
        : null
    if (request && targetLocation !== commentLocation && loadState !== 'ready')
      return
    if (request === jumpRequestRef.current) return
    jumpRequestRef.current = request
    jumpGenerationRef.current += 1
    pendingJumpRef.current = null
    if (!request || !targetThreadId || !targetLocation) return
    if (targetLocation === commentLocation) return
    const generation = jumpGenerationRef.current
    const href = servedLocation(targetLocation)
      ? commentLocationHref(targetLocation, fallbackToIndex)
      : null
    if (!href) {
      markJumpUnavailable(targetThreadId)
      return
    }
    // react-doctor-disable-next-line react-doctor/no-pass-data-to-parent
    navigateFrame(
      new URL(href, trustedMessageOrigin).href,
      () => generation === jumpGenerationRef.current,
      { threadId: targetThreadId, location: targetLocation },
    )
  }, [
    targetRequest,
    targetThreadId,
    targetLocation,
    commentLocation,
    servedLocation,
    fallbackToIndex,
    trustedMessageOrigin,
    loadState,
  ])

  useEffect(() => {
    if (!targetThreadId || loadState !== 'ready') return
    if (locationScoped && targetLocation !== commentLocation) return
    frameRef.current?.contentWindow?.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'scroll-to-comment',
        threadId: targetThreadId,
      },
      trustedMessageOrigin,
    )
  }, [
    loadState,
    targetRequest,
    targetThreadId,
    trustedMessageOrigin,
    locationScoped,
    targetLocation,
    commentLocation,
  ])

  useEffect(() => {
    if (loadState !== 'loading') return
    requestFrameReady()
    const interval = window.setInterval(
      requestFrameReady,
      FRAME_READY_CHECK_INTERVAL_MS,
    )
    const generation = frameNavigationIdRef.current
    // The ready fallback: a document that never answers a ready-check is
    // probed instead of waiting forever. The timer belongs to this effect, so
    // leaving 'loading' or unmounting clears it, and nothing else has to.
    const fallback = window.setTimeout(() => {
      void probe(generation)
    }, 3000)
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(fallback)
    }
  }, [loadState, probeCycle, requestFrameReady, probe])

  useEffect(() => {
    const resume = (
      event: 'visibilitychange' | 'pageshow',
      pageShowPersisted = false,
    ) => {
      if (
        !shouldStartLivenessCheck(
          event,
          document.visibilityState,
          pageShowPersisted,
        )
      )
        return
      const generation = frameNavigationIdRef.current
      requestFrameReady()
      window.setTimeout(() => {
        if (!shouldStartLivenessProbe(generation, frameNavigationIdRef.current))
          return
        frameNavigationIdRef.current += 1
        automaticRecoveryAttemptsRef.current = 0
        setRetryFailed(false)
        dispatchFrame({ type: 'load-state', loadState: 'loading' })
        restartProbeCycle()
      }, 500)
    }
    const onVisibilityChange = () => resume('visibilitychange')
    const onPageShow = (event: PageTransitionEvent) =>
      resume('pageshow', event.persisted)
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [requestFrameReady])

  useEffect(() => {
    if (wasTransitioningRef.current && !isTransitioning) {
      focusFrame()
    }
    wasTransitioningRef.current = isTransitioning
  }, [focusFrame, isTransitioning])

  return {
    violations,
    loadState,
    retryFailed,
    frameUrl,
    frameSourceChanged: frameState.changed,
    frameInstance,
    isTransitioning,
    frameRef,
    handleFrameLoad,
    retry: () => {
      focusRetryFailureRef.current = true
      const generation = frameNavigationIdRef.current + 1
      frameNavigationIdRef.current = generation
      frameDestinationRef.current += 1
      automaticRecoveryAttemptsRef.current = 0
      setRetryFailed(false)
      dispatchFrame({ type: 'load-state', loadState: 'resuming' })
      void refreshSandboxFrameUrl(shareableId, versionId, frameUrl, {
        getHash: hashSync.latest,
        getTargetUrl: () => recoveryDestinationRef.current,
      }).then(
        (nextFrameUrl) => {
          if (generation !== frameNavigationIdRef.current) return
          if (!nextFrameUrl) {
            setRetryFailed(true)
            dispatchFrame({ type: 'load-state', loadState: 'paused' })
            return
          }
          dispatchFrame({ type: 'reload', url: nextFrameUrl })
          restartFrameInstance()
        },
        () => {
          if (generation !== frameNavigationIdRef.current) return
          setRetryFailed(true)
          dispatchFrame({ type: 'load-state', loadState: 'paused' })
        },
      )
    },
    primaryActionRef,
    pendingExternalNavigation,
    cancelExternalNavigation: () => setPendingExternalNavigation(null),
    continueExternalNavigation: () => {
      if (!pendingExternalNavigation) return
      continueExternalNavigation(pendingExternalNavigation, window)
      setPendingExternalNavigation(null)
    },
  }
}

export async function refreshSandboxFrameUrl(
  shareableId: string,
  versionId: string,
  targetUrl: string,
  options: {
    navigation?: boolean
    getHash?: () => string
    getTargetUrl?: () => string
  } = {},
): Promise<string | null> {
  let result: {
    response: Response
    body: { sandboxUrl?: unknown; renderType?: unknown } | null
  }
  try {
    result = await fetchJsonWithViewerTimeout<{
      sandboxUrl?: unknown
      renderType?: unknown
    }>(
      `/api/shareables/${encodeURIComponent(shareableId)}/sandbox-token?version=${encodeURIComponent(versionId)}`,
      { cache: 'no-store' },
    )
  } catch (error) {
    logViewerNetworkEvent({
      channel: 'fetch',
      purpose: 'sandbox-token',
      state: 'failed',
      reason: viewerFetchFailureReason(error),
    })
    return null
  }
  const response = result.response
  if (!response.ok) {
    logViewerNetworkEvent({
      channel: 'fetch',
      purpose: 'sandbox-token',
      state: 'response-error',
      status: response.status,
      cfRay: cfRayFrom(response),
    })
    return null
  }
  const body = result.body
  if (typeof body?.sandboxUrl !== 'string') return null
  let nextUrl = new URL(options.getTargetUrl?.() ?? targetUrl)
  const entrypointUrl = new URL(body.sandboxUrl)
  const executionEnv = {
    APP_ENV: nextUrl.hostname.endsWith(SANDBOX_DEV_SUFFIX)
      ? 'development'
      : 'production',
  }
  const currentIdentity = sandboxVersionIdentityFromHostname(
    nextUrl.hostname,
    executionEnv,
  )
  const renewedIdentity = sandboxVersionIdentityFromHostname(
    entrypointUrl.hostname,
    executionEnv,
  )
  const expectedPort =
    executionEnv.APP_ENV === 'production' ? '' : entrypointUrl.port
  if (
    (executionEnv.APP_ENV !== 'production' && expectedPort === '') ||
    !currentIdentity ||
    !renewedIdentity ||
    currentIdentity.shareableId !== shareableId ||
    renewedIdentity.shareableId !== shareableId ||
    currentIdentity.domain !== renewedIdentity.domain ||
    nextUrl.protocol !== 'https:' ||
    entrypointUrl.protocol !== 'https:' ||
    nextUrl.port !== expectedPort ||
    entrypointUrl.port !== expectedPort
  )
    return null
  const previousNext = nextUrl.searchParams.get('as_next')
  const isRenewalEntry = nextUrl.searchParams.has('__as_token')
  if (isRenewalEntry) {
    nextUrl.search = withoutSearchParameters(nextUrl.search, ['as_next'])
    if (
      body.renderType === 'static_site' &&
      previousNext?.startsWith('/') &&
      !previousNext.startsWith('//')
    ) {
      try {
        const destination = new URL(previousNext, nextUrl.origin)
        if (destination.origin === nextUrl.origin) nextUrl = destination
      } catch {
        return null
      }
    }
  }
  nextUrl.search = withoutSearchParameters(nextUrl.search, [
    '__as_token',
    '__as_cookie_check',
  ])
  entrypointUrl.hash = options.navigation
    ? nextUrl.hash
    : (options.getHash?.() ?? window.location.hash)
  if (body.renderType === 'static_site') {
    if (
      normalizeStaticSiteFramePath(nextUrl.pathname) ===
      normalizeStaticSiteFramePath(entrypointUrl.pathname)
    ) {
      nextUrl.hash = entrypointUrl.hash
    } else {
      // Redirects without a fragment inherit the request fragment. Keep a
      // subpage's destination independent of the entrypoint's outer hash.
      entrypointUrl.hash = nextUrl.hash
    }
    entrypointUrl.searchParams.set(
      'as_next',
      `${nextUrl.pathname}${nextUrl.search}${nextUrl.hash}`,
    )
  }
  return entrypointUrl.href
}

function FrameLoading() {
  const { t } = useT()
  return (
    <output className="text-muted-foreground bg-surface-warm absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-sm">
      <div
        className="border-divider border-t-link size-6 animate-spin rounded-full border-2 [animation-duration:var(--anim-spin-duration)]"
        aria-hidden="true"
      />
      <span>{t('vw.frameLoading')}</span>
    </output>
  )
}
