import { installCspViolations } from './csp-violations.js'
import { installCodeCopy, updateMarkdownToc } from './toc.js'
import { installMessageListener, readEventValue, ready } from './messaging.js'
import { installAnchorObserver } from './mutations.js'
import { capturePrimordials, type ReporterWindow } from './primordials.js'
import { createReporterState } from './state.js'
import {
  READY_MESSAGE_REPEAT_COUNT,
  READY_MESSAGE_REPEAT_INTERVAL_MS,
} from '../reporter-constants.js'
import { anchorRoot, sendSelection } from './selection.js'
import {
  schedulePositionBadges,
  hitComment,
  selectThreadFromElement,
  rectFromPointer,
  sendOutsidePointerDown,
} from './badges.js'
import { clearMarks, applyHighlights } from './highlights.js'
import { onAnnotateHover, onAnnotateClick, verifyAnchors } from './annotate.js'
import { prepareLinkClick, finishLinkClick } from './links.js'
import { createTextAnchorEngine } from './anchor-engine.js'

export function installReporter(win: ReporterWindow) {
  if (win.parent === win) return
  const primordials = capturePrimordials(win)
  const ctx = createReporterState(win, primordials)
  try {
    let random = new win.Uint8Array(32)
    ctx.win.crypto.getRandomValues(random)
    ctx.documentToken = ctx.primordials
      .arrayMap(random, function (byte: number) {
        return byte.toString(16).padStart(2, '0')
      })
      .join('')
  } catch (e) {
    ctx.documentToken = ''
  }
  installAnchorObserver(ctx)
  ctx.primordials.addEventListener(ctx.win, 'pagehide', function (event) {
    if (readEventValue(ctx, ctx.primordials.persistedGet, event) === true)
      return
    ctx.anchorObserver!.disconnect()
    ctx.win.clearTimeout(ctx.resolveTimer)
    ctx.win.clearTimeout(ctx.checkingTimer)
    ctx.win.cancelAnimationFrame(ctx.badgePositionFrame)
    clearMarks(ctx)
  })
  ctx.doc.addEventListener('click', function (event) {
    let selection = ctx.win.getSelection()
    if (selection && !selection.isCollapsed) return
    let badge = hitComment(ctx, event)
    if (!badge) return
    selectThreadFromElement(
      ctx,
      badge,
      rectFromPointer(ctx, event, badge.getBoundingClientRect()),
    )
    event.preventDefault()
    event.stopPropagation()
  })
  ctx.primordials.addEventListener(
    ctx.doc,
    'mousemove',
    (event: Parameters<typeof onAnnotateHover>[1]) =>
      onAnnotateHover(ctx, event),
    true,
  )
  ctx.primordials.addEventListener(
    ctx.doc,
    'mouseover',
    (event: Parameters<typeof onAnnotateHover>[1]) =>
      onAnnotateHover(ctx, event),
    true,
  )
  ctx.primordials.addEventListener(
    ctx.doc,
    'click',
    (event: Parameters<typeof onAnnotateClick>[1]) =>
      onAnnotateClick(ctx, event),
    true,
  )
  installMessageListener(ctx)
  ctx.doc.addEventListener('mouseup', function () {
    ctx.win.setTimeout(() => sendSelection(ctx), 0)
  })
  ctx.doc.addEventListener('keyup', function () {
    ctx.win.setTimeout(() => sendSelection(ctx), 0)
  })
  installCodeCopy(ctx)
  ctx.primordials.addEventListener(
    ctx.win,
    'click',
    (event: Parameters<typeof prepareLinkClick>[1]) =>
      prepareLinkClick(ctx, event),
    true,
  )
  ctx.primordials.addEventListener(
    ctx.win,
    'click',
    (event: Parameters<typeof finishLinkClick>[1]) =>
      finishLinkClick(ctx, event),
  )
  ctx.doc.addEventListener(
    'pointerdown',
    (event: Parameters<typeof sendOutsidePointerDown>[1]) =>
      sendOutsidePointerDown(ctx, event),
  )
  installCspViolations(ctx)
  ctx.win.addEventListener('resize', () => schedulePositionBadges(ctx))
  ctx.win.addEventListener('scroll', () => schedulePositionBadges(ctx), true)
  ctx.win.addEventListener('load', function () {
    if (!ctx.pendingHighlights.length && !ctx.pendingAnchors.length) return
    let engine = createTextAnchorEngine(anchorRoot(ctx))
    try {
      applyHighlights(ctx, ctx.pendingHighlights, engine)
    } finally {
      verifyAnchors(ctx, ctx.pendingAnchors, engine)
    }
  })
  ctx.win.addEventListener('load', () => schedulePositionBadges(ctx))
  ctx.win.addEventListener('load', () => updateMarkdownToc(ctx))
  ctx.win.addEventListener('scroll', () => updateMarkdownToc(ctx), {
    passive: true,
  })
  if (ctx.doc.fonts && ctx.doc.fonts.ready) {
    ctx.doc.fonts.ready.then(() => schedulePositionBadges(ctx))
  }
  ctx.readyInterval = ctx.win.setInterval(function () {
    ready(ctx)
    if (++ctx.readyCount >= READY_MESSAGE_REPEAT_COUNT)
      ctx.win.clearInterval(ctx.readyInterval)
  }, READY_MESSAGE_REPEAT_INTERVAL_MS)
  ready(ctx)
  return ctx
}
