import { anchorIgnoreAttribute, highlightStyleId } from './anchor-engine.js'
import type { TextAnchorEngine } from './anchor-engine.js'
import type {
  CommentHighlight,
  ResolvedHighlight,
  ReporterState,
} from './state.js'
import { svgTextRange, wrapSvgRange } from './svg-overlay.js'
import {
  takeBadge,
  badgeStyleForHighlight,
  isBadgeAnchorVisible,
  positionBadges,
  schedulePositionBadges,
} from './badges.js'
import { createTextAnchorEngine } from './anchor-engine.js'
import { anchorRoot } from './selection.js'
import { verifyAnchors } from './annotate.js'
import { send } from './messaging.js'

export function ensureCommentStyles(ctx: ReporterState) {
  if (ctx.doc.getElementById(highlightStyleId())) return
  let style = ctx.doc.createElement('style')
  style.setAttribute(anchorIgnoreAttribute(), '')
  style.id = highlightStyleId()
  style.textContent =
    '.ash-comment-highlight-badge::after{content:attr(data-count);}'
  ctx.doc.head.appendChild(style)
}

export function clearMarks(ctx: ReporterState, preserveBadges = false) {
  for (let i = 0; i < ctx.badges.length; i++) {
    if (preserveBadges)
      ctx.reusableBadges.set(
        ctx.badges[i].badge.dataset.threadId!,
        ctx.badges[i].badge,
      )
    else ctx.badges[i].badge.remove()
  }
  ctx.badges = []
  ctx.paintedAnchors = []
  if (typeof ctx.win.CSS !== 'undefined' && ctx.win.CSS.highlights) {
    ctx.highlightNames.forEach(function (name) {
      ctx.win.CSS.highlights.delete(name)
    })
  }
  ctx.highlightNames = []
  ctx.textPaints = []
  let svgOverlays = ctx.doc.querySelectorAll<SVGElement>(
    '.ash-comment-highlight-svg',
  )
  for (let s = 0; s < svgOverlays.length; s++) svgOverlays[s].remove()
  if (!preserveBadges) ctx.svgActiveThreads = {}
  ctx.appliedHighlightKey = ''
  let style = ctx.doc.getElementById(highlightStyleId())
  if (style)
    style.textContent =
      '.ash-comment-highlight-badge::after{content:attr(data-count);}'
}

// Skipped writes compare live reporter-owned paint and DOM state.
export function paintIntact(
  ctx: ReporterState,
  highlightsById: Map<string, ResolvedHighlight>,
) {
  let style = ctx.doc.getElementById(highlightStyleId())
  if (
    ctx.paintedAnchors.length &&
    (!style || !style.isConnected || style.textContent !== textPaintCss(ctx))
  )
    return false
  if (typeof ctx.win.CSS !== 'undefined' && ctx.win.CSS.highlights) {
    for (let i = 0; i < ctx.textPaints.length; i++) {
      let paint = ctx.textPaints[i]
      if (
        ctx.win.CSS.highlights.get(paint.name) !== paint.highlight ||
        paint.highlight.size !== paint.ranges.length
      )
        return false
      for (let j = 0; j < paint.ranges.length; j++) {
        if (!paint.highlight.has(paint.ranges[j])) return false
      }
    }
  }
  for (let i = 0; i < ctx.badges.length; i++) {
    let entry = ctx.badges[i]
    if (
      !highlightsById.has(entry.highlight.threadId) ||
      !entry.badge.isConnected
    )
      return false
    if (entry.overlays) {
      let shapes = Object.values(entry.overlays)
      for (let j = 0; j < shapes.length; j++) {
        if (!shapes[j].isConnected) return false
      }
    }
  }
  return ctx.paintedAnchors.every(function (entry) {
    let next = highlightsById.get(entry.highlight.threadId)
    if (!next || next.ranges.length !== entry.ranges.length) return false
    for (let i = 0; i < entry.ranges.length; i++) {
      let range = entry.ranges[i]
      let current = next.ranges[i]
      if (
        range.startContainer !== current.startContainer ||
        range.startOffset !== current.startOffset ||
        range.endContainer !== current.endContainer ||
        range.endOffset !== current.endOffset
      )
        return false
    }
    if (entry.groups.length) {
      let groups = svgTextRange(ctx, entry.ranges)
      if (groups.length !== entry.groups.length) return false
      for (let i = 0; i < groups.length; i++) {
        let group = groups[i]
        let previous = entry.groups[i]
        if (
          group.text !== previous.text ||
          group.start !== previous.start ||
          group.end !== previous.end
        )
          return false
      }
    }
    return true
  })
}

export function setCommentLabels(
  ctx: ReporterState,
  labels: Record<string, unknown> | null | undefined,
) {
  if (!labels || typeof labels !== 'object') return
  if (typeof labels.openOne === 'string')
    ctx.commentLabels.openOne = labels.openOne
  if (typeof labels.openOther === 'string')
    ctx.commentLabels.openOther = labels.openOther
  if (typeof labels.resolvedOne === 'string')
    ctx.commentLabels.resolvedOne = labels.resolvedOne
  if (typeof labels.resolvedOther === 'string')
    ctx.commentLabels.resolvedOther = labels.resolvedOther
}

export function commentLabel(ctx: ReporterState, highlight: CommentHighlight) {
  let count = highlight.count || 1
  let template =
    highlight.status === 'resolved'
      ? count === 1
        ? ctx.commentLabels.resolvedOne
        : ctx.commentLabels.resolvedOther
      : count === 1
        ? ctx.commentLabels.openOne
        : ctx.commentLabels.openOther
  let label = template.replace(/\{n\}/g, String(count))
  return highlight.quotedText ? label + ': ' + highlight.quotedText : label
}

export function parseRgbColor(
  ctx: ReporterState,
  value: string,
): [number, number, number, number] | null {
  if (!value || value === 'transparent') return null
  let match = value.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/,
  )
  if (!match) return null
  return [
    parseFloat(match[1]),
    parseFloat(match[2]),
    parseFloat(match[3]),
    match[4] === undefined ? 1 : parseFloat(match[4]),
  ]
}

export function rgbToLuminance(
  ctx: ReporterState,
  r: number,
  g: number,
  b: number,
) {
  return 0.2126 * (r / 255) + 0.7152 * (g / 255) + 0.0722 * (b / 255)
}

export function parseColorValue(
  ctx: ReporterState,
  value: string,
):
  | { type: 'none' }
  | { type: 'rgb'; r: number; g: number; b: number; a: number }
  | { type: 'luminance'; value: number; a: number } {
  if (!value || value === 'transparent') return { type: 'none' }
  let rgb = parseRgbColor(ctx, value)
  if (rgb) {
    return { type: 'rgb', r: rgb[0], g: rgb[1], b: rgb[2], a: rgb[3] }
  }
  let modernMatch = value.match(
    /^oklch\(\s*([\d.]+)(%?)[^/)]*(?:\/\s*([\d.]+)(%?))?/,
  )
  if (modernMatch) {
    let lightness = parseFloat(modernMatch[1])
    if (modernMatch[2] === '%') lightness = lightness / 100
    let oklchAlpha =
      modernMatch[3] === undefined ? 1 : parseFloat(modernMatch[3])
    if (modernMatch[4] === '%') oklchAlpha = oklchAlpha / 100
    return { type: 'luminance', value: lightness, a: oklchAlpha }
  }
  modernMatch = value.match(/^lab\(\s*([\d.]+)(%?)[^/)]*(?:\/\s*([\d.]+)(%?))?/)
  if (modernMatch) {
    let labLightness = parseFloat(modernMatch[1])
    if (modernMatch[2] === '%') labLightness = labLightness / 100
    else labLightness = labLightness / 100
    let labAlpha = modernMatch[3] === undefined ? 1 : parseFloat(modernMatch[3])
    if (modernMatch[4] === '%') labAlpha = labAlpha / 100
    return { type: 'luminance', value: labLightness, a: labAlpha }
  }
  modernMatch = value.match(
    /^color\(\s*(?:display-p3|srgb)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)[^/)]*(?:\/\s*([\d.]+)(%?))?/,
  )
  if (modernMatch) {
    let colorAlpha =
      modernMatch[4] === undefined ? 1 : parseFloat(modernMatch[4])
    if (modernMatch[5] === '%') colorAlpha = colorAlpha / 100
    return {
      type: 'luminance',
      value:
        0.2126 * parseFloat(modernMatch[1]) +
        0.7152 * parseFloat(modernMatch[2]) +
        0.0722 * parseFloat(modernMatch[3]),
      a: colorAlpha,
    }
  }
  return { type: 'none' }
}

export function resolveBackgroundRgb(
  ctx: ReporterState,
  el: Element | null,
): [number, number, number] {
  while (el) {
    let parsed = parseColorValue(
      ctx,
      ctx.win.getComputedStyle(el).backgroundColor,
    )
    if (parsed.type === 'none') {
      el = el.parentElement
      continue
    }
    if (parsed.type === 'luminance') {
      if (parsed.a === 0) {
        el = el.parentElement
        continue
      }
      let gray = parsed.value * 255
      if (parsed.a < 1) {
        let ancestorRgb = resolveBackgroundRgb(ctx, el.parentElement)
        let lumAlpha = parsed.a
        return [
          gray * lumAlpha + ancestorRgb[0] * (1 - lumAlpha),
          gray * lumAlpha + ancestorRgb[1] * (1 - lumAlpha),
          gray * lumAlpha + ancestorRgb[2] * (1 - lumAlpha),
        ]
      }
      return [gray, gray, gray]
    }
    if (parsed.type === 'rgb') {
      if (parsed.a === 0) {
        el = el.parentElement
        continue
      }
      if (parsed.a < 1) {
        let ancestorRgb = resolveBackgroundRgb(ctx, el.parentElement)
        let alpha = parsed.a
        return [
          parsed.r * alpha + ancestorRgb[0] * (1 - alpha),
          parsed.g * alpha + ancestorRgb[1] * (1 - alpha),
          parsed.b * alpha + ancestorRgb[2] * (1 - alpha),
        ]
      }
      return [parsed.r, parsed.g, parsed.b]
    }
  }
  return [255, 255, 255]
}

export function resolvedLuminance(ctx: ReporterState, element: Element | null) {
  function resolveFrom(el: Element | null): number | null {
    while (el) {
      let parsed = parseColorValue(
        ctx,
        ctx.win.getComputedStyle(el).backgroundColor,
      )
      if (parsed.type === 'none') {
        el = el.parentElement
        continue
      }
      if (parsed.type === 'luminance') {
        if (parsed.a === 0) {
          el = el.parentElement
          continue
        }
        if (parsed.a < 1) {
          let ancestor = resolveFrom(el.parentElement)
          let ancestorLum = ancestor !== null ? ancestor : 1
          return parsed.value * parsed.a + ancestorLum * (1 - parsed.a)
        }
        return parsed.value
      }
      if (parsed.type === 'rgb') {
        if (parsed.a === 0) {
          el = el.parentElement
          continue
        }
        if (parsed.a < 1) {
          let ancestorRgb = resolveBackgroundRgb(ctx, el.parentElement)
          let alpha = parsed.a
          return rgbToLuminance(
            ctx,
            parsed.r * alpha + ancestorRgb[0] * (1 - alpha),
            parsed.g * alpha + ancestorRgb[1] * (1 - alpha),
            parsed.b * alpha + ancestorRgb[2] * (1 - alpha),
          )
        }
        return rgbToLuminance(ctx, parsed.r, parsed.g, parsed.b)
      }
    }
    return null
  }
  let result = resolveFrom(element)
  return result !== null ? result : 1
}

export function isDarkBackground(ctx: ReporterState, element: Element | null) {
  return resolvedLuminance(ctx, element) < 0.5
}

export function isDarkBackgroundForSvgText(ctx: ReporterState, text: Element) {
  if (!text) return isDarkBackground(ctx, ctx.doc.body)
  let fill = ctx.win.getComputedStyle(text).fill
  let parsed = parseColorValue(ctx, fill)
  if (parsed.type === 'rgb' && parsed.a > 0)
    return rgbToLuminance(ctx, parsed.r, parsed.g, parsed.b) >= 0.5
  if (parsed.type === 'luminance' && parsed.a > 0) return parsed.value >= 0.5
  return isDarkBackground(ctx, text)
}

export function textPaintCss(ctx: ReporterState) {
  return (
    '.ash-comment-highlight-badge::after{content:attr(data-count);}' +
    ctx.textPaints
      .map(function (paint) {
        return (
          '::highlight(' +
          paint.name +
          '){background-color:' +
          paint.palette.markBg +
          ';text-decoration:underline;text-decoration-color:' +
          (paint.active ? paint.palette.outline : paint.palette.markUnderline) +
          ';text-decoration-thickness:' +
          (paint.active ? '3px' : '2px') +
          ';}'
        )
      })
      .join('')
  )
}

export function refreshTextPaints(ctx: ReporterState) {
  let style = ctx.doc.getElementById(highlightStyleId())
  if (!style) return
  let css = textPaintCss(ctx)
  if (style.textContent !== css) style.textContent = css
}

export function highlightPalette(
  ctx: ReporterState,
  isDark: boolean,
  resolved: boolean,
) {
  if (isDark) {
    if (resolved) {
      return {
        markBg: 'rgba(134,197,165,.14)',
        markUnderline: 'rgba(134,197,165,.75)',
        outline: '#86c5a5',
        badgeBorder: 'rgba(134,197,165,.75)',
        badgeText: '#86c5a5',
        badgeBg: '#1f2937',
        badgeTargetBorder: '#86c5a5',
        badgeTargetText: '#fff',
        badgeTargetBg: '#86c5a5',
      }
    }
    return {
      markBg: 'rgba(96,165,250,.16)',
      markUnderline: 'rgba(96,165,250,.85)',
      outline: '#60a5fa',
      badgeBorder: 'rgba(96,165,250,.85)',
      badgeText: '#60a5fa',
      badgeBg: '#1f2937',
      badgeTargetBorder: '#60a5fa',
      badgeTargetText: '#fff',
      badgeTargetBg: '#60a5fa',
    }
  }
  if (resolved) {
    return {
      markBg: 'rgba(68,131,97,.12)',
      markUnderline: 'rgba(68,131,97,.58)',
      outline: '#448361',
      badgeBorder: 'rgba(68,131,97,.36)',
      badgeText: '#448361',
      badgeBg: '#fff',
      badgeTargetBorder: '#448361',
      badgeTargetText: '#fff',
      badgeTargetBg: '#448361',
    }
  }
  return {
    markBg: 'rgba(37,99,235,.16)',
    markUnderline: 'rgba(37,99,235,.72)',
    outline: '#2383e2',
    badgeBorder: 'rgba(35,131,226,.44)',
    badgeText: '#2383e2',
    badgeBg: '#fff',
    badgeTargetBorder: '#2383e2',
    badgeTargetText: '#fff',
    badgeTargetBg: '#2383e2',
  }
}

export function wrapRange(
  ctx: ReporterState,
  highlight: CommentHighlight,
  ranges: Range[],
  covered: boolean | null,
) {
  if (!ranges.length) return
  let groups =
    !covered && ctx.doc.querySelector('svg text')
      ? svgTextRange(ctx, ranges)
      : []
  ctx.paintedAnchors.push({
    highlight: highlight,
    ranges: ranges,
    groups: groups,
  })
  if (covered) return
  let svgWrapped = wrapSvgRange(ctx, highlight, groups)
  ensureCommentStyles(ctx)
  let name = 'ash-comment-' + ctx.highlightNames.length
  let palette = highlightPalette(
    ctx,
    isDarkBackground(ctx, ranges[0].startContainer.parentElement),
    highlight.status === 'resolved',
  )
  if (
    typeof ctx.win.CSS !== 'undefined' &&
    ctx.win.CSS.highlights &&
    typeof ctx.win.Highlight !== 'undefined'
  ) {
    let paint = new ctx.win.Highlight(...ranges)
    ctx.win.CSS.highlights.set(name, paint)
    ctx.highlightNames.push(name)
    ctx.textPaints.push({
      name: name,
      highlight: paint,
      ranges: ranges,
      threadId: highlight.threadId,
      palette: palette,
      active: highlight.target,
      target: highlight.target,
    })
    refreshTextPaints(ctx)
  }
  if (svgWrapped) return
  let badge = takeBadge(ctx, highlight)
  badge.setAttribute(anchorIgnoreAttribute(), '')
  badge.type = 'button'
  badge.className = 'ash-comment-highlight-badge'
  badge.setAttribute('aria-label', commentLabel(ctx, highlight))
  badge.dataset.threadId = highlight.threadId
  badge.dataset.count = String(highlight.count || 1)
  badge.style.cssText = badgeStyleForHighlight(
    ctx,
    highlight,
    isDarkBackground(ctx, ranges[0].startContainer.parentElement),
  )
  ctx.badges.push({
    badge: badge,
    highlight: highlight,
    measure: function () {
      let rects: DOMRect[] = []
      let lastElement = null
      ranges.forEach(function (range) {
        let current = Array.from(range.getClientRects())
        if (current.length) {
          rects.push(...current)
          lastElement = range.startContainer.parentElement
        }
      })
      return isBadgeAnchorVisible(ctx, lastElement) ? rects : []
    },
  })
}

export function missingState(
  ctx: ReporterState,
  id: string,
  checking: number[],
) {
  if (!ctx.checkingDeadlines[id]) ctx.checkingDeadlines[id] = Date.now() + 3000
  let deadline = ctx.checkingDeadlines[id]
  if (Date.now() < deadline) {
    checking.push(deadline)
    return 'checking'
  }
  return 'needs-check'
}

export function scheduleChecking(ctx: ReporterState, retryDelay = 0) {
  if (ctx.checkingTimer) ctx.win.clearTimeout(ctx.checkingTimer)
  // A checking report still needs a follow-up even if its deadline elapsed
  // during this pass. Keep both streams: verification must not cancel an
  // unchanged (signature-suppressed) highlight's outstanding report.
  let deadlines = ctx.checkingHighlights.concat(ctx.checkingAnchors)
  if (!deadlines.length) {
    ctx.checkingTimer = undefined
    return
  }
  ctx.checkingTimer = ctx.win.setTimeout(
    function () {
      ctx.checkingTimer = undefined
      let completed = false
      try {
        let engine = createTextAnchorEngine(anchorRoot(ctx))
        try {
          applyHighlights(ctx, ctx.pendingHighlights, engine)
        } finally {
          verifyAnchors(ctx, ctx.pendingAnchors, engine)
        }
        completed = true
      } finally {
        // Failed engine, paint, or verification work must not consume the
        // follow-up owed to either stream's last checking report.
        // Repeated failures back off to one retry per second. A successful
        // paired pass returns to normal deadline scheduling.
        scheduleChecking(
          ctx,
          completed ? 0 : Math.min(1000, Math.max(1, retryDelay * 2)),
        )
      }
    },
    Math.max(1, retryDelay, Math.min.apply(null, deadlines) - Date.now()),
  )
}

// Skip writes only while live reporter-owned values still match intact paint.
export function applyHighlights(
  ctx: ReporterState,
  list: CommentHighlight[],
  engine?: TextAnchorEngine,
) {
  ctx.anchorSnapshotGeneration++
  ctx.pendingHighlights = Array.isArray(list) ? list : []
  if (!ctx.pendingHighlights.length) {
    ctx.checkingHighlights = []
    ctx.lastResolutionSignature = ''
    scheduleChecking(ctx)
    clearMarks(ctx)
    return
  }
  // Stage the next report's obligations without discarding the last report
  // if resolution, painting, or serialization fails partway through the pass.
  let checking: number[] = []
  let forcePaint = !!engine
  engine = engine || createTextAnchorEngine(anchorRoot(ctx))
  ctx.measuredText = engine.text
  let results: {
    threadId: string
    state: string
    textStart: number | null
    textEnd: number | null
    textHash: string | null
  }[] = []
  let resolvedHighlights = ctx.pendingHighlights.map(function (highlight) {
    let resolved = engine.resolve(highlight)
    return {
      highlight: resolved ? { ...highlight, ...resolved } : highlight,
      resolved: resolved,
      ranges: resolved
        ? engine.ranges(resolved.textStart, resolved.textEnd)
        : [],
    }
  })
  let highlightsById = new Map(
    resolvedHighlights.map(function (entry) {
      return [entry.highlight.threadId, entry]
    }),
  )
  // Metadata echoes retain paint only while its DOM ranges and owned nodes survive.
  let paintKey = JSON.stringify(
    resolvedHighlights
      .map(function (entry) {
        let palettes = entry.ranges.map(function (range) {
          let element = range.startContainer.parentElement!
          let svgText =
            element.closest('svg text') &&
            element.closest('text,tspan,textPath')
          return [
            isDarkBackground(ctx, element),
            svgText ? isDarkBackgroundForSvgText(ctx, svgText) : null,
          ]
        })
        return [
          entry.highlight.threadId,
          entry.highlight.status,
          entry.highlight.target,
          palettes,
          entry.resolved && entry.resolved.textStart,
          entry.resolved && entry.resolved.textEnd,
        ] as const
      })
      .sort(function (left, right) {
        return left[0].localeCompare(right[0])
      }),
  )
  let repaint =
    forcePaint ||
    ctx.appliedHighlightKey !== paintKey ||
    !paintIntact(ctx, highlightsById)
  if (repaint) clearMarks(ctx, true)
  else {
    ctx.paintedAnchors.forEach(function (entry) {
      entry.highlight = highlightsById.get(entry.highlight.threadId)!.highlight
    })
    ctx.badges.forEach(function (entry) {
      let highlight = highlightsById.get(entry.highlight.threadId)!.highlight
      entry.highlight = highlight
      if (entry.badge.dataset.threadId !== highlight.threadId)
        entry.badge.dataset.threadId = highlight.threadId
      let count = String(highlight.count || 1),
        label = commentLabel(ctx, highlight)
      if (entry.badge.dataset.count !== count) entry.badge.dataset.count = count
      if (entry.badge.getAttribute('aria-label') !== label)
        entry.badge.setAttribute('aria-label', label)
    })
  }
  resolvedHighlights.forEach(function (entry) {
    let highlight = entry.highlight,
      resolved = entry.resolved
    let covered = false
    if (resolved && highlight.status === 'resolved') {
      for (let i = 0; i < resolvedHighlights.length; i++) {
        let other = resolvedHighlights[i]
        if (
          other.highlight.status !== 'resolved' &&
          other.resolved &&
          resolved.textStart < other.resolved.textEnd &&
          other.resolved.textStart < resolved.textEnd
        ) {
          covered = true
          break
        }
      }
    }
    if (resolved) {
      delete ctx.checkingDeadlines[highlight.threadId]
      if (repaint) wrapRange(ctx, entry.highlight, entry.ranges, covered)
    }
    results.push({
      threadId: highlight.threadId,
      state: resolved
        ? 'attached'
        : missingState(ctx, highlight.threadId, checking),
      textStart: resolved ? resolved.textStart : null,
      textEnd: resolved ? resolved.textEnd : null,
      textHash: resolved ? engine.hash : null,
    })
  })
  ctx.reusableBadges.forEach(function (badge) {
    badge.remove()
  })
  ctx.reusableBadges.clear()
  ctx.appliedHighlightKey = paintKey
  positionBadges(ctx)
  // The token is fixed for this installation. Keep it out of serialization:
  // authored code can replace JSON.stringify and prototype toJSON methods.
  let signature = JSON.stringify([
    ctx.displayedVersionId,
    ctx.displayedPath,
    results.map(function (result) {
      return [result.threadId, result.state, result.textStart, result.textEnd]
    }),
  ])
  if (signature !== ctx.lastResolutionSignature)
    for (let offset = 0; offset < results.length; offset += 100) {
      send(ctx, {
        kind: 'anchor-resolutions',
        token: ctx.documentToken,
        versionId: ctx.displayedVersionId,
        targetPath: ctx.displayedPath,
        generation: ++ctx.resolutionGeneration,
        results: results.slice(offset, offset + 100),
      })
    }
  ctx.lastResolutionSignature = signature
  ctx.checkingHighlights = checking
  scheduleChecking(ctx)
}

export function invalidateChangedPaint(
  ctx: ReporterState,
  engine: TextAnchorEngine,
) {
  ctx.paintedAnchors = ctx.paintedAnchors.filter(function (entry) {
    // Measure the entire span, including newly inserted nodes between pieces.
    let first = entry.ranges[0]
    let last = entry.ranges[entry.ranges.length - 1]
    if (
      engine.paintedText(first, last) ===
      engine.normalizedQuote(entry.highlight)
    )
      return true
    ctx.appliedHighlightKey = ''
    let id = entry.highlight.threadId
    ctx.textPaints = ctx.textPaints.filter(function (paint) {
      if (paint.threadId !== id) return true
      if (typeof ctx.win.CSS !== 'undefined' && ctx.win.CSS.highlights)
        ctx.win.CSS.highlights.delete(paint.name)
      return false
    })
    ctx.badges = ctx.badges.filter(function (badgeEntry) {
      if (badgeEntry.badge.dataset.threadId !== id) return true
      badgeEntry.badge.remove()
      return false
    })
    ctx.doc
      .querySelectorAll<SVGElement>('.ash-comment-highlight-svg')
      .forEach(function (shape) {
        if (shape.dataset.threadId === id) shape.remove()
      })
    return false
  })
}

export function scrollToThread(ctx: ReporterState, id: string) {
  let painted = ctx.paintedAnchors.find(function (entry) {
    return entry.highlight.threadId === id
  })
  if (painted && painted.ranges.length) {
    let start = painted.ranges[0].startContainer
    let target =
      start.nodeType === 1 ? (start as HTMLElement) : start.parentElement
    if (target) {
      target.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: 'instant',
      })
      // The parent may be an entire code block or paragraph. Reveal the
      // verified text rect within each scrollport, from the inside out.
      let range = painted.ranges[0]
      for (
        let ancestor: HTMLElement | null = target;
        ancestor && ancestor !== ctx.doc.scrollingElement;
        ancestor = ancestor.parentElement
      ) {
        let style = ctx.win.getComputedStyle(ancestor)
        let scrollX =
          /(auto|scroll|hidden|overlay)/.test(style.overflowX) &&
          ancestor.scrollWidth > ancestor.clientWidth
        let scrollY =
          /(auto|scroll|hidden|overlay)/.test(style.overflowY) &&
          ancestor.scrollHeight > ancestor.clientHeight
        if (!scrollX && !scrollY) continue
        let rect = range.getClientRects()[0]
        if (!rect) return
        let box = ancestor.getBoundingClientRect()
        let scaleX = ancestor.offsetWidth ? box.width / ancestor.offsetWidth : 1
        let scaleY = ancestor.offsetHeight
          ? box.height / ancestor.offsetHeight
          : 1
        if (!scaleX || !scaleY) continue
        let left = box.left + ancestor.clientLeft * scaleX
        let top = box.top + ancestor.clientTop * scaleY
        let width = ancestor.clientWidth * scaleX
        let height = ancestor.clientHeight * scaleY
        let dx =
          rect.left < left || rect.width > width
            ? rect.left - left
            : Math.max(0, rect.right - left - width)
        ancestor.scrollBy({
          left: scrollX ? dx / scaleX : 0,
          top: scrollY
            ? (rect.top + rect.height / 2 - top - height / 2) / scaleY
            : 0,
          behavior: 'instant',
        })
      }
      let visible = range.getClientRects()[0]
      if (visible) {
        let viewportWidth = ctx.doc.documentElement.clientWidth
        ctx.win.scrollBy({
          left:
            visible.left < 0 || visible.width > viewportWidth
              ? visible.left
              : Math.max(0, visible.right - viewportWidth),
          top:
            visible.top +
            visible.height / 2 -
            ctx.doc.documentElement.clientHeight / 2,
          behavior: 'instant',
        })
      }
      schedulePositionBadges(ctx)
    }
    return
  }
  let element = ctx.doc.querySelector(
    '.ash-comment-highlight[data-thread-id="' +
      ctx.win.CSS.escape(id) +
      '"], .ash-comment-highlight-badge[data-thread-id="' +
      ctx.win.CSS.escape(id) +
      '"], .ash-comment-highlight-svg[data-thread-id="' +
      ctx.win.CSS.escape(id) +
      '"]',
  )
  if (element) element.scrollIntoView({ block: 'center', behavior: 'smooth' })
}
