import {
  anchorIgnoreAttribute,
  commentUiAttribute,
  highlightStyleId,
} from './anchor-engine.js'
import { schedulePositionBadges } from './badges.js'
import type { ReporterState } from './state.js'
import { verifyAnchors } from './annotate.js'
import {
  EXCLUSION_CLASS_ATTRIBUTE,
  ignoredMutationSelector,
  createTextAnchorEngine,
} from './anchor-engine.js'
import { anchorRoot } from './selection.js'
import { applyHighlights, invalidateChangedPaint } from './highlights.js'

export function rebuildAfterMutations(ctx: ReporterState) {
  let hasText = ctx.pendingHighlights.length > 0
  for (let i = 0; !hasText && i < ctx.pendingAnchors.length; i++) {
    if (ctx.pendingAnchors[i].kind === 'text') hasText = true
  }
  if (!hasText) {
    verifyAnchors(ctx, ctx.pendingAnchors)
    return
  }
  let engine = createTextAnchorEngine(anchorRoot(ctx))
  if (engine.text === ctx.measuredText) {
    // Ranges are live DOM objects: rebuild even for equal-value node replacement.
    ctx.win.clearTimeout(ctx.resolveTimer)
    ctx.resolveStartedAt = 0
    try {
      applyHighlights(ctx, ctx.pendingHighlights, engine)
    } finally {
      verifyAnchors(ctx, ctx.pendingAnchors, engine)
    }
  } else {
    invalidateChangedPaint(ctx, engine)
    ctx.win.clearTimeout(ctx.resolveTimer)
    if (!ctx.resolveStartedAt) ctx.resolveStartedAt = Date.now()
    let snapshotGeneration = ctx.anchorSnapshotGeneration
    ctx.resolveTimer = ctx.win.setTimeout(
      function () {
        ctx.resolveStartedAt = 0
        if (snapshotGeneration !== ctx.anchorSnapshotGeneration)
          engine = createTextAnchorEngine(anchorRoot(ctx))
        try {
          applyHighlights(ctx, ctx.pendingHighlights, engine)
        } finally {
          verifyAnchors(ctx, ctx.pendingAnchors, engine)
        }
      },
      Math.min(300, Math.max(0, 1000 - (Date.now() - ctx.resolveStartedAt))),
    )
  }
}
export function handleMutations(ctx: ReporterState, records: MutationRecord[]) {
  let root = anchorRoot(ctx)
  let rootReplaced = root !== ctx.observedAnchorRoot
  ctx.observedAnchorRoot = root
  // Exclusion changes can arrive while a text debounce is pending, including
  // on nodes now ignored by the normal mutation filter. Never reuse that snapshot.
  let exclusionChanged = false
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex]
    if (
      record.type === 'attributes' &&
      (record.attributeName === anchorIgnoreAttribute() ||
        record.attributeName === commentUiAttribute() ||
        record.attributeName === EXCLUSION_CLASS_ATTRIBUTE)
    ) {
      exclusionChanged = true
      break
    }
  }
  if (rootReplaced || exclusionChanged) ctx.anchorSnapshotGeneration++
  if (
    !root ||
    !ctx.doc.body ||
    (!ctx.pendingHighlights.length && !ctx.pendingAnchors.length)
  )
    return
  let hasRelevant = false
  let hasRelevantContent = false
  for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
    const record = records[recordIndex]
    if (record.type !== 'attributes' && !root.contains(record.target)) continue
    let element =
      record.target.nodeType === 1
        ? (record.target as Element)
        : record.target.parentElement
    if (element && ctx.primordials.closest(element, ignoredMutationSelector()))
      continue
    if (record.type === 'childList') {
      let hasContentNode = false
      for (let group = 0; group < 2; group++) {
        const nodes = group === 0 ? record.addedNodes : record.removedNodes
        for (let index = 0; index < nodes.length; index++) {
          const node = nodes[index]
          if (
            node.nodeType !== 1 ||
            (!ctx.primordials.hasAttribute(
              node as Element,
              anchorIgnoreAttribute(),
            ) &&
              (node as Element).id !== highlightStyleId())
          )
            hasContentNode = true
        }
      }
      if (!hasContentNode) continue
    }
    hasRelevant = true
    if (record.type !== 'attributes') hasRelevantContent = true
  }
  if (!rootReplaced && !hasRelevant) return
  // Layout changes never alter anchor text, but live range geometry may change.
  schedulePositionBadges(ctx)
  if (rootReplaced || hasRelevantContent) {
    // Observe ancestors too: replacing the content root invalidates its ranges.
    rebuildAfterMutations(ctx)
  }
}
export function installAnchorObserver(ctx: ReporterState) {
  ctx.observedAnchorRoot = anchorRoot(ctx)
  const observer = new ctx.win.MutationObserver((records) =>
    handleMutations(ctx, records),
  )
  ctx.anchorObserver = observer
  observer.observe(ctx.doc.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  })
  return observer
}
