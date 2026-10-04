import {
  READY_CHECK_MESSAGE_KIND,
  READY_CHECK_MESSAGE_SOURCE,
} from '../reporter-constants.js'
import {
  setCommentLabels,
  applyHighlights,
  scrollToThread,
} from './highlights.js'
import { installMermaidResults, requestMermaidRendering } from './mermaid.js'
import {
  setAnnotateMode,
  pingElement,
  flashElement,
  verifyAnchors,
} from './annotate.js'
import type { ReporterState } from './state.js'

// Secret-bearing messages reach only captured messaging primordials.
export function send(ctx: ReporterState, message: Record<string, unknown>) {
  try {
    let payload = createMessagePayload(ctx.primordials, message)
    ctx.primordials.savedPostMessage(ctx.primordials.savedParent, payload, '*')
  } catch (e) {}
}

export function ready(ctx: ReporterState) {
  if (ctx.readyChallenge && ctx.documentToken) {
    send(ctx, {
      kind: 'ready',
      challenge: ctx.readyChallenge,
      token: ctx.documentToken,
    })
  }
}

export function onReadyCheck(ctx: ReporterState, event: MessageEvent) {
  let message = event && event.data
  if (
    !event ||
    event.source !== ctx.primordials.savedParent ||
    !message ||
    message.source !== READY_CHECK_MESSAGE_SOURCE ||
    message.kind !== READY_CHECK_MESSAGE_KIND
  )
    return
  if (typeof message.challenge !== 'string' || !message.challenge) return
  ctx.readyChallenge = message.challenge
  requestMermaidRendering(ctx)
  ready(ctx)
}

export function readEventValue<T>(
  ctx: ReporterState,
  getter: ((event: Event) => T) | null,
  event: Event,
) {
  if (!getter) return null
  try {
    return getter(event)
  } catch (e) {
    return null
  }
}

export function createMessagePayload(
  primitives: Pick<ReporterState['primordials'], 'objectCreate' | 'objectKeys'>,
  message: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = primitives.objectCreate(null)
  payload.source = 'artifactshare'
  // Do not invoke the authored realm's replaceable Array iterator with keys
  // of messages containing the private document token or ready challenge.
  const keys = primitives.objectKeys(message)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    payload[key] = message[key]
  }
  return payload
}
export function installMessageListener(ctx: ReporterState) {
  ctx.primordials.savedAddEventListener('message', function (event) {
    let data = event.data || {}
    if (
      event.source !== ctx.primordials.savedParent ||
      data.source !== READY_CHECK_MESSAGE_SOURCE
    ) {
      return
    }
    if (data.kind === READY_CHECK_MESSAGE_KIND) {
      onReadyCheck(ctx, event)
      ctx.displayedVersionId = data.versionId || ctx.displayedVersionId
      ctx.displayedPath = data.targetPath || ctx.displayedPath
      ctx.textAnchorsEnabled = data.textAnchorsEnabled === true
      setCommentLabels(ctx, data.commentLabels)
    } else if (
      data.kind === 'external-link-policy' &&
      (data.mode === 'parent' || data.mode === 'direct')
    ) {
      ctx.externalLinkPolicyMode = data.mode
    } else if (data.kind === 'comment-highlights') {
      ctx.textAnchorsEnabled = data.textAnchorsEnabled === true
      setCommentLabels(ctx, data.commentLabels)
      ctx.displayedVersionId = data.versionId || null
      ctx.displayedPath = data.targetPath || null
      applyHighlights(ctx, data.highlights)
    } else if (data.kind === 'scroll-to-comment') {
      scrollToThread(ctx, data.threadId)
    } else if (data.kind === 'mermaid-rendered') {
      installMermaidResults(ctx, data.renderToken, data.results)
    } else if (data.kind === 'annotate-mode') {
      setAnnotateMode(ctx, data.enabled)
    } else if (data.kind === 'element-ping') {
      pingElement(ctx, data.selector)
    } else if (data.kind === 'element-flash') {
      flashElement(ctx, data.selector)
    } else if (data.kind === 'verify-anchors') {
      if (
        Number.isSafeInteger(ctx.pendingVerificationId) &&
        Number.isSafeInteger(data.verificationId) &&
        data.verificationId < ctx.pendingVerificationId!
      )
        return
      ctx.pendingVerificationId = data.verificationId
      verifyAnchors(ctx, data.anchors)
    }
  })
}
