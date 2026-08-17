import { toast } from 'sonner'
import { IconCheck, IconFile, IconPlugConnected } from '@tabler/icons-react'
import {
  useCallback,
  useEffect,
  useEffectEvent,
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
  type CspViolationMessage,
  type LinkClickedMessage,
  type MermaidRenderRequestMessage,
  type TextSelectionMessage,
} from '~/lib/csp-reporter'
import { t as translate, tPlural as translatePlural } from '~/lib/i18n'
import { APEX_HOST, WWW_HOST } from '~/lib/hosts'
import {
  SANDBOX_PROBE_MARKER,
  SANDBOX_PROBE_PATH,
} from '~/lib/sandbox-block-report'
import { DeniedPanel } from '~/components/app/denied-panel'
import { Button } from '~/components/ui/button'
import { sandboxMessageFromFrame } from '~/lib/sandbox-frame-message'
import { renderMermaidSvg } from '~/lib/mermaid-render.client'
import {
  classifyViewerLinkNavigation,
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
  classifySandboxProbeResponse,
  shouldAcceptNavigationResult,
  shouldReportBlock,
  shouldStartLivenessCheck,
  shouldStartLivenessProbe,
} from '~/lib/sandbox-frame-state'

// The per-artifact sandbox origin is the trust boundary for messages. The
// source check keeps sibling frames on the same page from spoofing reports.
interface ViolationEntry extends CspViolationMessage {
  id: string
}

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

async function renderMermaidRequest(message: MermaidRenderRequestMessage) {
  return await message.diagrams.reduce<
    Promise<Array<{ id: string; svg: string }>>
  >(async (pending, diagram) => {
    // Mermaid diagram renderers share temporary DOM state, so keep the batch sequential.
    // react-doctor-disable-next-line react-doctor/async-await-in-loop
    const results = await pending
    try {
      results.push({
        id: diagram.id,
        svg: await renderMermaidSvg(diagram.source),
      })
    } catch {
      // The source code block remains visible when a diagram cannot render.
    }
    return results
  }, Promise.resolve([]))
}

type SandboxFrameProps = {
  shareableId: string
  versionId?: string | null
  url: string
  name: string
  mermaidEnabled: boolean
  textAnchorsEnabled: boolean
  linkNavigationMode: LinkNavigationMode
  bundlePaths: ReadonlyArray<string>
  fallbackToIndex: boolean
  commentThreads: ReadonlyArray<CommentThreadView>
  targetThreadId: string | null
  highlightThreadId: string | null
  followsAppTheme: boolean
  onTextSelection: (selection: PendingTextAnchor) => void
  onTextSelectionClear: () => void
  onThreadSelect: (threadId: string, rect: TextSelectionMessage['rect']) => void
  onOutsidePointerDown: () => void
  onFramePathChange?: (path: string) => void
  sandboxPermissions: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads'
  children?: ReactNode
}

const SANDBOX_FRAME_BASE_CLASS_NAME = 'block h-full w-full border-0'

export function sandboxFrameSurfaceClassName(followsAppTheme: boolean) {
  return followsAppTheme
    ? `${SANDBOX_FRAME_BASE_CLASS_NAME} bg-background [color-scheme:light_dark] dark:[color-scheme:dark] [[data-theme=light]_&]:[color-scheme:light]`
    : `${SANDBOX_FRAME_BASE_CLASS_NAME} bg-white [color-scheme:light]`
}

export function SandboxFrame(props: SandboxFrameProps) {
  const { shareableId, name, sandboxPermissions, children } = props
  const controller = useSandboxFrameController(props)

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
          ref={controller.frameRef}
          title={name}
          src={controller.frameUrl}
          allow="fullscreen; clipboard-write"
          sandbox={sandboxPermissions}
          referrerPolicy="no-referrer"
          className={`${sandboxFrameSurfaceClassName(props.followsAppTheme)} ${controller.loadState !== 'ready' && controller.loadState !== 'loading' ? 'hidden' : ''}`}
          onLoad={controller.handleFrameLoad}
        />
        {controller.loadState === 'loading' ? <FrameLoading /> : null}
      </div>
      {children}
      {controller.violations.length > 0 && (
        <CspBanner violations={controller.violations} />
      )}
    </ViewerBodySurface>
  )
}

export function ViewerBodySurface(props: ComponentProps<'main'>) {
  return (
    <main
      // full-bleed by design: the viewer body sits flush under the topbar
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
              <p className="text-foreground mt-2 flex items-center gap-1.5 font-medium">
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
              <p className="text-foreground mt-2 flex items-center gap-1.5 font-medium">
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
              >
                {t('vw.sandboxPaused.resume')}
              </Button>
              <p>{t('vw.sandboxPaused.next')}</p>
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
  highlightThreadId,
  onTextSelection,
  onTextSelectionClear,
  onThreadSelect,
  onOutsidePointerDown,
  onFramePathChange,
  sandboxPermissions,
}: SandboxFrameProps) {
  const { locale, t } = useT()
  const [violations, setViolations] = useState<ViolationEntry[]>([])
  const [loadState, setLoadState] = useState<
    'loading' | 'ready' | 'resuming' | 'blocked' | 'paused'
  >('loading')
  const [frameUrl, setFrameUrl] = useReducer(
    (_current: string, next: string) => next,
    url,
  )
  const [probeCycle, restartProbeCycle] = useReducer(
    (current: number) => current + 1,
    0,
  )
  const isTransitioning = useViewTransitionState(`/a/${shareableId}`)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const wasTransitioningRef = useRef(false)
  const readyFallbackTimeoutRef = useRef<number | null>(null)
  const staticSiteAuthRef = useRef<number | null>(null)
  const frameNavigationIdRef = useRef(0)
  const reportedGenerationRef = useRef<number | null>(null)
  const reportTimerRef = useRef<number | null>(null)
  const primaryActionRef = useRef<HTMLButtonElement>(null)
  const focusRetryFailureRef = useRef(false)
  const securityChallengeRef = useRef<string | null>(null)
  const securityTokenRef = useRef<string | null>(null)
  const mermaidRenderChallengeRef = useRef<string | null>(null)
  if (staticSiteAuthRef.current === null) {
    staticSiteAuthRef.current = Date.now()
  }
  const trustedMessageOrigin = new URL(url).origin
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
  const highlights = useMemo(() => {
    const textHighlights = commentThreads.flatMap((thread) => {
      const subject = thread.subject
      if (
        subject.kind !== 'text' ||
        subject.state !== 'attached' ||
        subject.textStart === null ||
        subject.textEnd === null
      ) {
        return []
      }
      return {
        threadId: thread.id,
        status: thread.status,
        textStart: subject.textStart,
        textEnd: subject.textEnd,
        quotedText: subject.quotedText,
        target: thread.id === highlightThreadId,
        count: thread.messages.length,
      }
    })
    const openHighlights = textHighlights.filter(
      (highlight) => highlight.status === 'open',
    )
    return textHighlights.filter(
      (highlight) =>
        highlight.status === 'open' ||
        !openHighlights.some(
          (openHighlight) =>
            openHighlight.threadId !== highlight.threadId &&
            openHighlight.textStart < highlight.textEnd &&
            openHighlight.textEnd > highlight.textStart,
        ),
    )
  }, [commentThreads, highlightThreadId])

  const clearReadyFallback = useCallback(() => {
    if (readyFallbackTimeoutRef.current !== null) {
      window.clearTimeout(readyFallbackTimeoutRef.current)
      readyFallbackTimeoutRef.current = null
    }
  }, [])

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
        const body = await response.text()
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
          setLoadState('resuming')
          const next = await refreshSandboxFrameUrl(
            shareableId,
            frameUrl,
            versionId,
          )
          if (
            !shouldAcceptNavigationResult(
              generation,
              frameNavigationIdRef.current,
            )
          )
            return
          if (next) {
            setFrameUrl(next)
            setLoadState('loading')
          } else {
            setLoadState('paused')
          }
        } else if (outcome === 'forbidden') {
          setLoadState('blocked')
          reportBlock('forbidden')
        } else {
          setLoadState('blocked')
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
        setLoadState('blocked')
        reportBlock(
          error instanceof DOMException && error.name === 'AbortError'
            ? 'timeout'
            : 'network-error',
        )
      } finally {
        window.clearTimeout(timeout)
      }
    },
    [frameUrl, reportBlock, shareableId, versionId],
  )

  const markFrameReadyFromMessage = useEffectEvent(() => {
    clearReadyFallback()
    if (reportTimerRef.current !== null) {
      window.clearTimeout(reportTimerRef.current)
      reportTimerRef.current = null
    }
    const generation = frameNavigationIdRef.current + 1
    frameNavigationIdRef.current = generation
    setLoadState('ready')
    if (focusRetryFailureRef.current) {
      focusRetryFailureRef.current = false
      focusFrame()
    }
  })
  const handleTextSelectionMessage = useEffectEvent(
    (message: TextSelectionMessage) => {
      const frameRect = frameRef.current?.getBoundingClientRect()
      onTextSelection({
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
        onFramePathChange?.(
          normalizeStaticSiteFramePath(new URL(action.url).pathname),
        )
        const navigationId = frameNavigationIdRef.current + 1
        frameNavigationIdRef.current = navigationId
        const lastStaticSiteAuthAt = staticSiteAuthRef.current ?? Date.now()
        const needsRefresh = Date.now() - lastStaticSiteAuthAt > 9 * 60 * 1000
        if (!needsRefresh) {
          clearReadyFallback()
          setViolations([])
          setLoadState('loading')
          setFrameUrl(action.url)
          return
        }
        void refreshSandboxFrameUrl(shareableId, action.url, versionId).then(
          (nextFrameUrl) => {
            if (navigationId !== frameNavigationIdRef.current) return
            if (!nextFrameUrl) {
              toast(t('toast.linkRecoveryFailed'))
              return
            }
            staticSiteAuthRef.current = Date.now()
            clearReadyFallback()
            setViolations([])
            setLoadState('loading')
            setFrameUrl(nextFrameUrl)
          },
        )
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
        textAnchorsEnabled,
        commentLabels,
      },
      '*',
    )
  }, [commentLabels, textAnchorsEnabled])

  const sendHighlights = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'comment-highlights',
        textAnchorsEnabled,
        commentLabels,
        highlights,
      },
      trustedMessageOrigin,
    )
  }, [commentLabels, highlights, textAnchorsEnabled, trustedMessageOrigin])

  const focusFrame = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active !== document.body && active !== frameRef.current) return
      frameRef.current?.focus({ preventScroll: true })
    })
  }, [])

  const handleFrameLoad = useCallback(() => {
    securityChallengeRef.current = createSandboxChallenge()
    securityTokenRef.current = null
    mermaidRenderChallengeRef.current = null
    requestFrameReady()
    clearReadyFallback()
    sendHighlights()
  }, [clearReadyFallback, requestFrameReady, sendHighlights])

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const message = sandboxMessageFromFrame(
        event,
        trustedMessageOrigin,
        frameRef.current?.contentWindow,
      )
      if (!message) return
      if (message.kind === 'csp-violation') {
        setViolations((prev) => [
          ...prev,
          { ...message, id: crypto.randomUUID() },
        ])
      } else if (message.kind === 'ready') {
        securityTokenRef.current = acceptSandboxToken(
          securityTokenRef.current,
          securityChallengeRef.current,
          message.challenge,
          message.token,
        )
        markFrameReadyFromMessage()
        clearReadyFallback()
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
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [clearReadyFallback, mermaidEnabled, trustedMessageOrigin])

  useEffect(() => {
    if (loadState !== 'ready') return
    sendHighlights()
  }, [loadState, sendHighlights])

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

  useEffect(() => {
    if (!targetThreadId || loadState !== 'ready') return
    frameRef.current?.contentWindow?.postMessage(
      {
        source: 'artifactshare-parent',
        kind: 'scroll-to-comment',
        threadId: targetThreadId,
      },
      trustedMessageOrigin,
    )
  }, [loadState, targetThreadId, trustedMessageOrigin])

  useEffect(() => {
    if (loadState !== 'loading') return
    requestFrameReady()
    const interval = window.setInterval(requestFrameReady, 250)
    const generation = frameNavigationIdRef.current
    const fallback = window.setTimeout(() => {
      void probe(generation)
    }, 3000)
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(fallback)
    }
  }, [loadState, probeCycle, requestFrameReady, probe])

  useEffect(() => {
    const resume = (event: 'visibilitychange' | 'pageshow') => {
      if (!shouldStartLivenessCheck(event, document.visibilityState)) return
      const generation = frameNavigationIdRef.current
      requestFrameReady()
      window.setTimeout(() => {
        if (!shouldStartLivenessProbe(generation, frameNavigationIdRef.current))
          return
        frameNavigationIdRef.current += 1
        setLoadState('loading')
        restartProbeCycle()
      }, 500)
    }
    const onVisibilityChange = () => resume('visibilitychange')
    const onPageShow = () => resume('pageshow')
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [requestFrameReady])

  useEffect(() => {
    return clearReadyFallback
  }, [clearReadyFallback])

  useEffect(() => {
    if (wasTransitioningRef.current && !isTransitioning) {
      focusFrame()
    }
    wasTransitioningRef.current = isTransitioning
  }, [focusFrame, isTransitioning])

  return {
    violations,
    loadState,
    frameUrl,
    isTransitioning,
    frameRef,
    handleFrameLoad,
    retry: () => {
      focusRetryFailureRef.current = true
      frameNavigationIdRef.current += 1
      setLoadState('loading')
    },
    primaryActionRef,
  }
}

async function refreshSandboxFrameUrl(
  shareableId: string,
  targetUrl: string,
  versionId?: string | null,
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
      `/api/shareables/${encodeURIComponent(shareableId)}/sandbox-token${versionId ? `?version=${encodeURIComponent(versionId)}` : ''}`,
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
  const nextUrl = new URL(targetUrl)
  const entrypointUrl = new URL(body.sandboxUrl)
  if (body.renderType === 'static_site') {
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

function CspBanner({ violations }: { violations: ViolationEntry[] }) {
  const { t, tPlural } = useT()
  const count = violations.length
  return (
    <aside
      className="text-foreground max-w-sandbox-toast-max border-border bg-card fixed right-4 bottom-4 z-50 rounded-[var(--r-md)] border px-3.5 py-2.5 text-sm shadow-[var(--shadow-lg)]"
      role="status"
    >
      <span className="block font-medium">
        {tPlural('csp.banner.summary', count)}
      </span>
      <details className="text-muted-foreground mt-1.5">
        <summary className="cursor-pointer select-none">
          {t('csp.banner.detailsSummary')}
        </summary>
        <ul className="mt-2 list-disc pl-4">
          {violations.map((v) => (
            <li key={v.id} className="my-0.5 break-all">
              <code className="font-mono text-xs">{v.directive}</code> blocked{' '}
              <code className="font-mono text-xs">{v.blockedURI}</code>
            </li>
          ))}
        </ul>
      </details>
    </aside>
  )
}
