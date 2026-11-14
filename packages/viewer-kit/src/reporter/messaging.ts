import { reportHash } from './hash.js'
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
  trackPreviewPick,
  setAnnotateMode,
  pingElement,
  flashElement,
  verifyAnchors,
} from './annotate.js'
import type { ReporterState } from './state.js'
import { reportScreen, showScreen } from './screen.js'
import {
  lockInlineEdit,
  sendInlineEditText,
  startInlineEdit,
} from './inline-edit.js'

// Secret-bearing messages reach only captured messaging primordials.
export function send(ctx: ReporterState, message: Record<string, unknown>) {
  try {
    let payload = createMessagePayload(ctx.primordials, message)
    if (ctx.previewCapability) {
      payload.previewCapability = ctx.previewCapability
      payload.documentGeneration = ctx.previewGeneration
      payload.sequence = ++ctx.previewSendSequence
    }
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
    reportHash(ctx, true)
    reportScreen(ctx, true)
    // A newer handshake drops older messages: say the draft text again.
    sendInlineEditText(ctx)
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
  // The parent may have rejected an earlier verdict before registering the
  // document token. A new handshake must let that same verdict be sent again.
  if (ctx.readyChallenge !== message.challenge) ctx.lastResolutionSignature = ''
  ctx.readyChallenge = message.challenge
  for (let index = 0; index < ctx.pendingCspViolationCount; index++) {
    send(ctx, ctx.pendingCspViolations[index])
  }
  ctx.pendingCspViolations = ctx.primordials.objectCreate(null)
  ctx.pendingCspViolationCount = 0
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
    if ((key === 'locus' || key === 'targetPath') && message[key] === undefined)
      continue
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
    // Preview is opt-in. Hosted viewers retain their existing protocol.
    // WebKit fires the frame's load event on a same-document hash change, so
    // the parent may start a newer handshake for this same document; follow
    // it rather than ignoring every later parent message.
    if (
      data.kind === READY_CHECK_MESSAGE_KIND &&
      typeof data.previewCapability === 'string' &&
      /^[a-f0-9]{64}$/.test(data.previewCapability) &&
      Number.isSafeInteger(data.documentGeneration) &&
      data.documentGeneration > 0 &&
      (!ctx.previewCapability ||
        data.documentGeneration > ctx.previewGeneration)
    ) {
      ctx.previewCapability = data.previewCapability
      ctx.previewGeneration = data.documentGeneration
      ctx.previewReceiveSequence = 0
    }
    if (ctx.previewCapability) {
      if (
        data.previewCapability !== ctx.previewCapability ||
        data.documentGeneration !== ctx.previewGeneration ||
        !Number.isSafeInteger(data.sequence) ||
        data.sequence <= ctx.previewReceiveSequence
      )
        return
      ctx.previewReceiveSequence = data.sequence
    }
    if (data.kind === READY_CHECK_MESSAGE_KIND) {
      // Scope first, so the ready report records this document's location.
      ctx.locationScoped = data.locationScoped === true
      ctx.fallbackToIndex = data.fallbackToIndex === true
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
      ctx.locationScoped = data.locationScoped === true
      ctx.fallbackToIndex = data.fallbackToIndex === true
      applyHighlights(ctx, data.highlights)
    } else if (data.kind === 'scroll-to-comment') {
      scrollToThread(ctx, data.threadId)
    } else if (data.kind === 'mermaid-rendered') {
      installMermaidResults(ctx, data.renderToken, data.results)
    } else if (data.kind === 'track-annotation-pick') {
      trackPreviewPick(ctx, data.pickSequence)
    } else if (data.kind === 'inline-edit') {
      startInlineEdit(ctx, data.pickSequence)
    } else if (data.kind === 'inline-edit-lock') {
      lockInlineEdit(ctx, data.locked)
    } else if (data.kind === 'show-screen') {
      showScreen(ctx, data.screen)
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
