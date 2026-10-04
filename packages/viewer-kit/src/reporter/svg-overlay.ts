import { anchorIgnoreAttribute } from './anchor-engine.js'
import type { CommentHighlight, SvgTextGroup, ReporterState } from './state.js'
import {
  refreshTextPaints,
  ensureCommentStyles,
  highlightPalette,
  isDarkBackgroundForSvgText,
  commentLabel,
} from './highlights.js'
import {
  isBadgeAnchorVisible,
  takeBadge,
  badgeStyleForHighlight,
} from './badges.js'

export function setSvgHighlightState(
  ctx: ReporterState,
  threadId: string,
  active: boolean,
) {
  ctx.textPaints.forEach(function (paint) {
    if (paint.threadId === threadId) paint.active = active || paint.target
  })
  refreshTextPaints(ctx)
  let overlays = ctx.doc.querySelectorAll<SVGElement>(
    '.ash-comment-highlight-svg[data-thread-id="' +
      ctx.win.CSS.escape(threadId) +
      '"]',
  )
  for (let i = 0; i < overlays.length; i++) {
    let overlay = overlays[i]
    let palette = overlay.dataset.palette
    if (!palette) continue
    let parts = palette.split('|')
    let normalFill = parts[0]
    let outline = parts[1]
    let target = overlay.dataset.target === 'true'
    let state = active || target ? 'active' : 'normal'
    let applied = ctx.svgOverlayStyles.get(overlay)
    if (overlay.dataset.state !== state) overlay.dataset.state = state
    if (
      applied &&
      applied.state === state &&
      overlay.getAttribute('style') === applied.style
    )
      continue
    if (active || target) {
      overlay.style.fill = normalFill
      overlay.style.stroke = outline
      overlay.style.strokeWidth = '2'
      overlay.style.vectorEffect = 'non-scaling-stroke'
    } else {
      overlay.style.fill = normalFill
      overlay.style.stroke = 'none'
      overlay.style.strokeWidth = '0'
    }
    ctx.svgOverlayStyles.set(overlay, {
      state: state,
      style: overlay.getAttribute('style'),
    })
  }
}

export function svgTextRange(ctx: ReporterState, ranges: Range[]) {
  return ranges.flatMap(function (range) {
    let node = range.startContainer
    if (!node.parentElement!.closest('svg text')) return []
    // SVG character indexes are local to the text content element. A tspan
    // avoids counting indentation or collapsed separators in sibling spans.
    let text = node.parentElement!.closest<SVGTextContentElement>(
      'text,tspan,textPath',
    )
    if (!text || !text.getNumberOfChars) return []
    let walker = ctx.doc.createTreeWalker(text, ctx.win.NodeFilter.SHOW_TEXT)
    let raw = [],
      collapsed = [],
      candidate
    let whitespace = false
    while ((candidate = walker.nextNode())) {
      let value = candidate.nodeValue || ''
      for (let offset = 0; offset < value.length; offset++) {
        let unit = { node: candidate, offset: offset }
        raw.push([unit])
        if (/[\t\n\r ]/.test(value[offset])) {
          if (!collapsed.length) continue
          if (whitespace) collapsed[collapsed.length - 1].push(unit)
          else collapsed.push([unit])
          whitespace = true
        } else {
          collapsed.push([unit])
          whitespace = false
        }
      }
    }
    if (whitespace) collapsed.pop()
    let count = text.getNumberOfChars()
    let characters =
      collapsed.length === count ? collapsed : raw.length === count ? raw : null
    // Do not guess glyph offsets when the browser's shaping disagrees.
    if (!characters) return []
    let start = -1,
      end = -1
    characters.forEach(function (units, index) {
      if (
        units.some(function (unit) {
          return (
            unit.node === node &&
            unit.offset >= range.startOffset &&
            unit.offset < range.endOffset
          )
        })
      ) {
        if (start < 0) start = index
        end = index + 1
      }
    })
    return start < 0 ? [] : [{ text: text, start: start, end: end }]
  })
}

export function wrapSvgRange(
  ctx: ReporterState,
  highlight: CommentHighlight,
  groups: SvgTextGroup[],
) {
  if (!groups.length) return false
  let texts = groups
    .map(function (group) {
      return group.text
    })
    .filter(function (text, index, all) {
      return all.indexOf(text) === index
    })
  let first = texts[0]
  let svg = first && first.ownerSVGElement
  while (svg && svg.ownerSVGElement) svg = svg.ownerSVGElement
  if (!svg || !svg.parentNode) return false
  ensureCommentStyles(ctx)
  let overlays: Record<string, SVGRectElement> = {}
  let badgeEntry = {
    badge: null as HTMLButtonElement | null,
    highlight: highlight,
    overlays: overlays,
    measure: measureSvgRange,
  }

  function overlayKey(text: SVGTextContentElement, index: string) {
    return texts.indexOf(text) + ':' + index
  }

  function setAttributeIfChanged(
    shape: SVGRectElement,
    name: string,
    value: string | number,
  ) {
    value = String(value)
    if (shape.getAttribute(name) !== value)
      shape.setAttribute(name, String(value))
  }

  function updateOverlay(
    text: SVGTextContentElement,
    index: string,
    box: Pick<DOMRect, 'x' | 'y' | 'width' | 'height'>,
    screenCtm: DOMMatrix | null,
  ) {
    let currentHighlight = badgeEntry.highlight
    let key = overlayKey(text, index)
    let shape = overlays[key]
    if (!shape) {
      shape = ctx.doc.createElementNS('http://www.w3.org/2000/svg', 'rect')
      shape.setAttribute('class', 'ash-comment-highlight-svg')
      shape.setAttribute(anchorIgnoreAttribute(), '')
      shape.setAttribute('pointer-events', 'none')
      shape.dataset.threadId = currentHighlight.threadId
      shape.dataset.target = currentHighlight.target ? 'true' : 'false'
      let palette = highlightPalette(
        ctx,
        isDarkBackgroundForSvgText(ctx, text),
        currentHighlight.status === 'resolved',
      )
      shape.dataset.palette = palette.markBg + '|' + palette.outline
      // Shapes must be siblings of <text>, not children of a <text>/<tspan>.
      let textRoot = text.closest('text')
      textRoot!.parentNode!.insertBefore(shape, textRoot)
      overlays[key] = shape
    }
    let scaleX = screenCtm ? Math.hypot(screenCtm.a, screenCtm.b) : 1
    let scaleY = screenCtm ? Math.hypot(screenCtm.c, screenCtm.d) : 1
    let padX = scaleX ? 2 / scaleX : 2
    let padY = scaleY ? 2 / scaleY : 2
    setAttributeIfChanged(shape, 'x', box.x - padX)
    setAttributeIfChanged(shape, 'y', box.y - padY)
    setAttributeIfChanged(shape, 'width', box.width + padX * 2)
    setAttributeIfChanged(shape, 'height', box.height + padY * 2)
    let textCtm = text.getCTM ? text.getCTM() : null
    let parentNode = shape.parentNode as SVGGraphicsElement | null
    let parentCtm = parentNode && parentNode.getCTM ? parentNode.getCTM() : null
    if (textCtm && parentCtm && parentCtm.inverse) {
      let matrix = parentCtm.inverse().multiply(textCtm)
      setAttributeIfChanged(
        shape,
        'transform',
        'matrix(' +
          [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].join(
            ' ',
          ) +
          ')',
      )
    } else if (shape.hasAttribute('transform')) {
      shape.removeAttribute('transform')
    }
    return shape
  }

  function measureSvgRange() {
    let current = []
    let lastElement = null
    let usedOverlays: Record<string, boolean> = {}
    for (let i = 0; i < groups.length; i++) {
      let group = groups[i]
      let ctm = group.text.getScreenCTM ? group.text.getScreenCTM() : null
      let runs = []
      for (let index = group.start; index < group.end; index++) {
        try {
          let box = group.text.getExtentOfChar(index)
          if (!box || box.width < 0 || box.height <= 0) continue
          let previous = runs.length ? runs[runs.length - 1] : null
          let overlapsVertically =
            previous &&
            box.y <= previous.y + previous.height &&
            previous.y <= box.y + box.height
          let sameLine =
            previous &&
            overlapsVertically &&
            box.x <= previous.x + previous.width + Math.max(4, box.height * 0.5)
          if (sameLine && previous) {
            let runRight = Math.max(
              previous.x + previous.width,
              box.x + box.width,
            )
            let runBottom = Math.max(
              previous.y + previous.height,
              box.y + box.height,
            )
            previous.x = Math.min(previous.x, box.x)
            previous.y = Math.min(previous.y, box.y)
            previous.width = runRight - previous.x
            previous.height = runBottom - previous.y
          } else {
            runs.push({
              x: box.x,
              y: box.y,
              width: box.width,
              height: box.height,
            })
          }
        } catch (e) {}
      }
      for (let runIndex = 0; runIndex < runs.length; runIndex++) {
        try {
          let run = runs[runIndex]
          let overlayIndex = i + '-' + runIndex
          let overlay = updateOverlay(group.text, overlayIndex, run, ctm)
          let display = isBadgeAnchorVisible(ctx, group.text)
            ? 'inline'
            : 'none'
          if (overlay.style.display !== display) overlay.style.display = display
          usedOverlays[overlayKey(group.text, overlayIndex)] = true
          let points = [
            [run.x, run.y],
            [run.x + run.width, run.y],
            [run.x, run.y + run.height],
            [run.x + run.width, run.y + run.height],
          ].map(function (point) {
            return ctm
              ? new ctx.win.DOMPoint(point[0], point[1]).matrixTransform(ctm)
              : { x: point[0], y: point[1] }
          })
          let left = Math.min.apply(
            null,
            points.map(function (point) {
              return point.x
            }),
          )
          let top = Math.min.apply(
            null,
            points.map(function (point) {
              return point.y
            }),
          )
          let right = Math.max.apply(
            null,
            points.map(function (point) {
              return point.x
            }),
          )
          let bottom = Math.max.apply(
            null,
            points.map(function (point) {
              return point.y
            }),
          )
          if (right > left && bottom > top) {
            current.push({
              left: left,
              right: right,
              top: top,
              width: right - left,
              height: bottom - top,
            })
            lastElement = group.text
          }
        } catch (e) {}
      }
    }
    Object.keys(overlays).forEach(function (key) {
      if (!usedOverlays[key]) {
        overlays[key].remove()
        delete overlays[key]
      }
    })
    setSvgHighlightState(
      ctx,
      highlight.threadId,
      ctx.svgActiveThreads[highlight.threadId] === true,
    )
    if (current.length)
      return isBadgeAnchorVisible(ctx, lastElement) ? current : []
    if (!isBadgeAnchorVisible(ctx, first)) return []
    let fallback = first.getBoundingClientRect
      ? first.getBoundingClientRect()
      : null
    if (!fallback || fallback.width === 0 || fallback.height === 0) {
      fallback = svg!.getBoundingClientRect()
    }
    return fallback ? [fallback] : []
  }

  let badge = takeBadge(ctx, highlight)
  badge.setAttribute(anchorIgnoreAttribute(), '')
  badge.type = 'button'
  badge.className = 'ash-comment-highlight-badge'
  badge.dataset.threadId = highlight.threadId
  badge.dataset.count = String(highlight.count || 1)
  badge.setAttribute('aria-label', commentLabel(ctx, highlight))
  badge.innerHTML =
    highlight.status === 'resolved'
      ? '<svg viewBox="0 0 24 24" width="10" height="10" style="width:10px;height:10px;flex:none;border:0;padding:0;margin:0;background:none;box-shadow:none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>'
      : '<svg viewBox="0 0 24 24" width="10" height="10" style="width:10px;height:10px;flex:none;border:0;padding:0;margin:0;background:none;box-shadow:none" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"/></svg>'
  badge.style.cssText = badgeStyleForHighlight(
    ctx,
    highlight,
    isDarkBackgroundForSvgText(ctx, first),
  )
  badgeEntry.badge = badge
  ctx.badges.push(badgeEntry as import('./state.js').BadgeEntry)
  measureSvgRange()
  return true
}
