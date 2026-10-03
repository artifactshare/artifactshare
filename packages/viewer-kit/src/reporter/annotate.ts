import type { TextAnchorEngine } from './anchor-engine.js'
import type { VerificationAnchor, ReporterState } from './state.js'
import { createTextAnchorEngine } from './anchor-engine.js'
import { anchorRoot, cssPath } from './selection.js'
import { missingState, scheduleChecking } from './highlights.js'
import { send } from './messaging.js'

export function ensureAnnotateStyles(ctx: ReporterState) {
  if (ctx.doc.getElementById('as-preview-annotate-style')) return
  let style = ctx.doc.createElement('style')
  style.setAttribute('data-anchor-ignore', '')
  style.id = 'as-preview-annotate-style'
  style.textContent =
    '.as-preview-annotate-hover{outline:2px solid #6366f1 !important;outline-offset:2px;}' +
    '.as-preview-pinged{outline:2px solid #6366f1 !important;outline-offset:2px;background-color:rgba(99,102,241,0.12) !important;transition:background-color 0.4s ease;}' +
    '.as-preview-flash{background-color:rgba(34,197,94,0.35) !important;transition:background-color 1s ease;}' +
    '.as-preview-flash-fade{background-color:transparent !important;}'
  ctx.doc.head.appendChild(style)
}

export function annotateTargetFrom(
  ctx: ReporterState,
  eventTarget: EventTarget | null,
) {
  const target = eventTarget as Element | null
  if (!target || target.nodeType !== 1) return null
  if (target === ctx.doc.body || target === ctx.doc.documentElement) return null
  if (target.closest && target.closest('[data-comment-ui]')) return null
  return target
}

export function clearAnnotateHover(ctx: ReporterState) {
  if (ctx.annotateHoverElement) {
    ctx.annotateHoverElement.classList.remove('as-preview-annotate-hover')
    ctx.annotateHoverElement = null
  }
}

export function elementLabel(ctx: ReporterState, el: Element) {
  let quote = function (text: string) {
    return '"' + text + '"'
  }
  let tag = el.nodeName.toLowerCase()
  let ariaLabel = el.getAttribute && el.getAttribute('aria-label')
  if (ariaLabel) return tag + ' ' + quote(ariaLabel.trim())
  let text = (el.textContent || '').replace(/\s+/g, ' ').trim()
  if (text) return tag + ' ' + quote(text.slice(0, 25))
  if (tag === 'img') {
    let alt = el.getAttribute('alt')
    if (alt) return 'img ' + quote(alt.trim())
  }
  let role = el.getAttribute && el.getAttribute('role')
  if (role) return tag + ' [role=' + role + ']'
  return tag
}

export function siblingText(ctx: ReporterState, el: Element | null) {
  return el && el.textContent
    ? el.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)
    : ''
}

export function annotateContextText(ctx: ReporterState, el: Element) {
  let own = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 100)
  let before = siblingText(ctx, el.previousElementSibling)
  let after = siblingText(ctx, el.nextElementSibling)
  let parts = [own]
  if (before) parts.push('[before: ' + before + ']')
  if (after) parts.push('[after: ' + after + ']')
  return parts.join(' ').trim()
}

export function verifyAnchors(
  ctx: ReporterState,
  anchors: VerificationAnchor[],
  engine?: TextAnchorEngine,
) {
  ctx.anchorSnapshotGeneration++
  ctx.pendingAnchors = anchors || []
  if (!ctx.pendingAnchors.length) return
  let verdicts = []
  if (
    !engine &&
    ctx.pendingAnchors.some(function (anchor) {
      return anchor.kind === 'text'
    })
  )
    engine = createTextAnchorEngine(anchorRoot(ctx))
  for (let i = 0; i < (anchors || []).length; i++) {
    let anchor = anchors[i] || {}
    let attached = false
    if (anchor.kind === 'element') {
      attached = findElement(ctx, anchor) !== null
    } else if (anchor.kind === 'text') {
      attached = engine!.resolve(anchor) !== null
    }
    if (attached) delete ctx.checkingDeadlines[anchor.thread]
    verdicts.push({
      thread: anchor.thread,
      attached: attached,
      position_state: attached ? 'attached' : missingState(ctx, anchor.thread),
    })
  }
  send(ctx, {
    kind: 'anchor-verdicts',
    verificationId: ctx.pendingVerificationId,
    generation: ++ctx.resolutionGeneration,
    verdicts: verdicts,
  })
  scheduleChecking(ctx)
}

export function findElement(
  ctx: ReporterState,
  anchor: Extract<VerificationAnchor, { kind: 'element' }>,
) {
  if (!anchor.ownText) {
    // Nothing to search for, so the selector is all there is.
    try {
      return ctx.doc.querySelector(anchor.selector)
    } catch (error) {
      return null
    }
  }
  let peers = anchor.tagName
    ? anchorRoot(ctx).getElementsByTagName(anchor.tagName)
    : anchorRoot(ctx).getElementsByTagName('*')
  let matches = []
  for (let i = 0; i < peers.length; i++) {
    if (ownText(ctx, peers[i]) === anchor.ownText) matches.push(peers[i])
  }
  if (matches.length === 0) return null
  if (matches.length === 1) return matches[0]
  for (let j = 0; j < matches.length; j++) {
    if (annotateContextText(ctx, matches[j]) === anchor.contextText)
      return matches[j]
  }
  // Several identical candidates and none in the captured surroundings:
  // saying "attached" here would point the comment at content nobody wrote
  // it about.
  return null
}

export function ownText(ctx: ReporterState, el: Element) {
  return (el.textContent || '').replace(/\s+/g, ' ').trim()
}

export function setAnnotateMode(ctx: ReporterState, enabled: unknown) {
  ctx.annotateModeEnabled = enabled === true
  if (ctx.annotateModeEnabled) {
    ensureAnnotateStyles(ctx)
  } else {
    clearAnnotateHover(ctx)
  }
}

export function pingElement(ctx: ReporterState, selector: unknown) {
  if (typeof selector !== 'string' || !selector) return
  let el = null
  try {
    el = ctx.doc.querySelector(selector)
  } catch (error) {}
  if (!el) return
  ensureAnnotateStyles(ctx)
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('as-preview-pinged')
  ctx.win.setTimeout(function () {
    el.classList.remove('as-preview-pinged')
  }, 2500)
}

export function flashElement(ctx: ReporterState, selector: unknown) {
  if (typeof selector !== 'string' || !selector) return
  let el = null
  try {
    el = ctx.doc.querySelector(selector)
  } catch (error) {}
  if (!el) return
  ensureAnnotateStyles(ctx)
  el.classList.add('as-preview-flash')
  ctx.win.setTimeout(function () {
    el.classList.add('as-preview-flash-fade')
  }, 100)
  ctx.win.setTimeout(function () {
    el.classList.remove('as-preview-flash')
    el.classList.remove('as-preview-flash-fade')
  }, 1100)
}

export function onAnnotateHover(ctx: ReporterState, event: MouseEvent) {
  if (!ctx.annotateModeEnabled) return
  let target = annotateTargetFrom(
    ctx,
    ctx.primordials.targetGet ? ctx.primordials.targetGet(event) : event.target,
  )
  if (target === ctx.annotateHoverElement) return
  clearAnnotateHover(ctx)
  if (!target) return
  ctx.annotateHoverElement = target
  target.classList.add('as-preview-annotate-hover')
}

export function onAnnotateClick(ctx: ReporterState, event: MouseEvent) {
  if (!ctx.annotateModeEnabled) return
  let target = annotateTargetFrom(
    ctx,
    ctx.primordials.targetGet ? ctx.primordials.targetGet(event) : event.target,
  )
  if (!target) return
  event.preventDefault()
  event.stopPropagation()
  // The click that ends a drag-selection belongs to that selection, not to
  // an element pick. Both would otherwise open the popover and the anchor
  // kind would depend on which task the browser ran first.
  let selected = ctx.win.getSelection()
  if (selected && !selected.isCollapsed && selected.toString().trim()) return
  let rect = target.getBoundingClientRect()
  send(ctx, {
    kind: 'element-annotate',
    selector: cssPath(ctx, target),
    label: elementLabel(ctx, target),
    contextText: annotateContextText(ctx, target),
    ownText: ownText(ctx, target),
    tagName: target.tagName,
    rect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
  })
}
