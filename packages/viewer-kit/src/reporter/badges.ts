import type {
  CommentHighlight,
  BadgeEntry,
  ReporterPointerEvent,
  ReporterState,
} from './state.js'
import { highlightPalette } from './highlights.js'
import { trusted } from './links.js'
import { setSvgHighlightState } from './svg-overlay.js'
import { send } from './messaging.js'

export function badgeStyleForHighlight(
  ctx: ReporterState,
  highlight: CommentHighlight,
  isDark: boolean,
) {
  let palette = highlightPalette(ctx, isDark, highlight.status === 'resolved')
  let base =
    'display:inline-flex;align-items:center;gap:4px;min-height:16px;padding:0 5px;border-radius:999px;font:700 10px system-ui,sans-serif;box-shadow:0 2px 8px rgba(27,39,35,.08);cursor:pointer;touch-action:none;position:absolute;z-index:2147483646;'
  let borderColor
  let textColor
  let bgColor
  if (highlight.target) {
    borderColor = palette.badgeTargetBorder
    textColor = palette.badgeTargetText
    bgColor = palette.badgeTargetBg
  } else {
    borderColor = palette.badgeBorder
    textColor = palette.badgeText
    bgColor = palette.badgeBg
  }
  return (
    base +
    'border:1px solid ' +
    borderColor +
    ';color:' +
    textColor +
    ';background:' +
    bgColor +
    ';'
  )
}

export function positionSingleBadge(ctx: ReporterState, entry: BadgeEntry) {
  let badge = entry.badge
  let rects = measureBadgeEntry(ctx, entry)
  let rect = rects.length ? rects[rects.length - 1] : null
  if (!rect || rect.width === 0 || rect.height === 0) {
    badge.style.display = 'none'
    return
  }
  badge.style.display = 'inline-flex'
  badge.style.left = '0px'
  badge.style.top = '0px'
  let base = badge.getBoundingClientRect()
  let scaleX = badge.offsetWidth ? base.width / badge.offsetWidth : 1
  let scaleY = badge.offsetHeight ? base.height / badge.offsetHeight : 1
  if (!scaleX || !isFinite(scaleX)) scaleX = 1
  if (!scaleY || !isFinite(scaleY)) scaleY = 1
  let badgeHeight = badge.offsetHeight || 16
  let threadId = badge.dataset.threadId!
  let offset = ctx.badgeOffsets[threadId] || { x: 0, y: 0 }
  badge.style.left = (rect.right - base.left) / scaleX - 6 + offset.x + 'px'
  badge.style.top =
    (rect.top - base.top) / scaleY - badgeHeight + 3 + offset.y + 'px'
}

export function positionBadges(ctx: ReporterState) {
  let layouts = []
  for (let i = 0; i < ctx.badges.length; i++) {
    let badge = ctx.badges[i].badge
    let rects = measureBadgeEntry(ctx, ctx.badges[i])
    let rect = rects.length ? rects[rects.length - 1] : null
    badge.style.display = 'inline-flex'
    badge.style.left = '0px'
    badge.style.top = '0px'
    let base = badge.getBoundingClientRect()
    let scaleX = badge.offsetWidth ? base.width / badge.offsetWidth : 1
    let scaleY = badge.offsetHeight ? base.height / badge.offsetHeight : 1
    if (!scaleX || !isFinite(scaleX)) scaleX = 1
    if (!scaleY || !isFinite(scaleY)) scaleY = 1
    layouts.push({
      badge: badge,
      rect: rect,
      base: base,
      badgeHeight: badge.offsetHeight || 16,
      scaleX: scaleX,
      scaleY: scaleY,
      threadId: badge.dataset.threadId!,
    })
  }
  for (let j = 0; j < layouts.length; j++) {
    let layout = layouts[j]
    if (!layout.rect || layout.rect.width === 0 || layout.rect.height === 0) {
      layout.badge.style.display = 'none'
      continue
    }
    let offset = ctx.badgeOffsets[layout.threadId!] || { x: 0, y: 0 }
    layout.badge.style.display = 'inline-flex'
    layout.badge.style.left =
      (layout.rect.right - layout.base.left) / layout.scaleX -
      6 +
      offset.x +
      'px'
    layout.badge.style.top =
      (layout.rect.top - layout.base.top) / layout.scaleY -
      layout.badgeHeight +
      3 +
      offset.y +
      'px'
  }
}

export function isBadgeAnchorVisible(
  ctx: ReporterState,
  element: Element | null,
) {
  // Visibility affects badge geometry, not selector text or painted ranges.
  if (!element) return false
  let visibility = ctx.win.getComputedStyle(element).visibility
  if (visibility === 'hidden' || visibility === 'collapse') return false
  let boxedElement: Element | null = element
  while (
    boxedElement &&
    ctx.win.getComputedStyle(boxedElement).display === 'contents'
  ) {
    boxedElement = boxedElement.parentElement
  }
  return (
    !!boxedElement &&
    !!boxedElement.getClientRects().length &&
    (!boxedElement.checkVisibility || boxedElement.checkVisibility())
  )
}

export function measureBadgeEntry(ctx: ReporterState, entry: BadgeEntry) {
  if (entry.measure) return entry.measure()
  return []
}

export function schedulePositionBadges(ctx: ReporterState) {
  if (ctx.badgePositionFrame) return
  ctx.badgePositionFrame = ctx.win.requestAnimationFrame(function () {
    ctx.badgePositionFrame = 0
    positionBadges(ctx)
  })
}

export function takeBadge(ctx: ReporterState, highlight: CommentHighlight) {
  let badge = ctx.reusableBadges.get(highlight.threadId)
  if (badge) ctx.reusableBadges.delete(highlight.threadId)
  else {
    badge = ctx.doc.createElement('button')
    bindBadgePointer(ctx, badge)
  }
  if (!badge.isConnected) ctx.doc.documentElement.appendChild(badge)
  return badge
}

export function hitComment(ctx: ReporterState, event: ReporterPointerEvent) {
  // Firefox can give keyboard link activation a positive click count.
  // PointerEvent uses an empty pointerType for non-pointer activation;
  // older Firefox MouseEvents identify keyboard input with source 6.
  if (
    !trusted(ctx, event) ||
    (event.type === 'click' &&
      (event.detail <= 0 ||
        event.pointerType === '' ||
        event.mozInputSource === 6))
  )
    return null
  for (let index = 0; index < ctx.badges.length; index++) {
    let rects = measureBadgeEntry(ctx, ctx.badges[index])
    if (
      Array.from(rects).some(function (rect) {
        return (
          event.clientX >= rect.left &&
          event.clientX <= rect.right &&
          event.clientY >= rect.top &&
          event.clientY <= rect.bottom!
        )
      })
    )
      return ctx.badges[index].badge
  }
  return null
}

export function rectFromPointer(
  ctx: ReporterState,
  event: MouseEvent,
  fallback: Pick<DOMRect, 'top' | 'left' | 'width' | 'height'>,
) {
  if (
    event.detail !== 0 &&
    typeof event.clientX === 'number' &&
    typeof event.clientY === 'number'
  ) {
    return {
      top: event.clientY - 8,
      left: event.clientX,
      width: 1,
      height: 16,
    }
  }
  return fallback
}

export function bindBadgePointer(ctx: ReporterState, badge: HTMLButtonElement) {
  let dragState: {
    pointerId: number
    startX: number
    startY: number
    offsetX: number
    offsetY: number
    dragged: boolean
  } | null = null
  let badgeEntry: BadgeEntry | null = null

  function finishDrag(event: PointerEvent) {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    if (event.type === 'pointerup' && dragState.dragged) ctx.badgeDragged = true
    try {
      badge.releasePointerCapture(event.pointerId)
    } catch (e) {}
    dragState = null
  }

  badge.addEventListener('pointerdown', function (event) {
    ctx.badgeDragged = false
    if (event.button !== 0) return
    for (let i = 0; i < ctx.badges.length; i++) {
      if (ctx.badges[i].badge === badge) {
        badgeEntry = ctx.badges[i]
        break
      }
    }
    let threadId = badge.dataset.threadId!
    let offset = ctx.badgeOffsets[threadId] || { x: 0, y: 0 }
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      offsetX: offset.x,
      offsetY: offset.y,
      dragged: false,
    }
    try {
      badge.setPointerCapture(event.pointerId)
    } catch (e) {}
    event.preventDefault()
  })

  badge.addEventListener('pointermove', function (event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return
    let dx = event.clientX - dragState.startX
    let dy = event.clientY - dragState.startY
    if (!dragState.dragged && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      dragState.dragged = true
    }
    if (!dragState.dragged) return
    let threadId = badge.dataset.threadId!
    ctx.badgeOffsets[threadId] = {
      x: dragState.offsetX + dx,
      y: dragState.offsetY + dy,
    }
    if (badgeEntry) positionSingleBadge(ctx, badgeEntry)
  })

  badge.addEventListener('pointerup', finishDrag)
  badge.addEventListener('pointercancel', finishDrag)

  badge.addEventListener('click', function (event) {
    if (ctx.badgeDragged) {
      ctx.badgeDragged = false
      event.preventDefault()
      event.stopPropagation()
      return
    }
    let r = badge.getBoundingClientRect()
    selectThreadFromElement(ctx, badge, rectFromPointer(ctx, event, r))
    event.preventDefault()
    event.stopPropagation()
  })
  function updateSvgActive(active: boolean) {
    ctx.svgActiveThreads[badge.dataset.threadId!] = active
    setSvgHighlightState(ctx, badge.dataset.threadId!, active)
  }
  badge.addEventListener('pointerenter', function () {
    updateSvgActive(true)
  })
  badge.addEventListener('pointerleave', function () {
    updateSvgActive(ctx.doc.activeElement === badge)
  })
  badge.addEventListener('focus', function () {
    updateSvgActive(true)
  })
  badge.addEventListener('blur', function () {
    updateSvgActive(badge.matches(':hover'))
  })
}

export function selectThreadFromElement(
  ctx: ReporterState,
  element: HTMLButtonElement,
  rect: Pick<DOMRect, 'top' | 'left' | 'width' | 'height'>,
) {
  send(ctx, {
    kind: 'comment-thread-selected',
    threadId: element.dataset.threadId,
    rect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
  })
}

export function sendOutsidePointerDown(
  ctx: ReporterState,
  event: PointerEvent,
) {
  if (!ctx.textAnchorsEnabled || hitComment(ctx, event)) return
  let target = event.target as Element | null
  if (
    target &&
    target.closest &&
    target.closest(
      '.ash-comment-highlight, .ash-comment-highlight-badge, [data-code-copy]',
    )
  ) {
    return
  }
  send(ctx, { kind: 'comment-outside-pointer-down' })
}
