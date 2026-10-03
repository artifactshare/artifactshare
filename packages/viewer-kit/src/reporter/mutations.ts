import { schedulePositionBadges } from './badges.js'
import type { ReporterState } from './state.js'
import { verifyAnchors } from './annotate.js'
import { createTextAnchorEngine } from './anchor-engine.js'
import { anchorRoot } from './selection.js'
import { applyHighlights, invalidateChangedPaint } from './highlights.js'

export function rebuildAfterMutations(ctx: ReporterState) {
  let hasText =
    ctx.pendingHighlights.length ||
    ctx.pendingAnchors.some(function (anchor) {
      return anchor.kind === 'text'
    })
  if (!hasText) {
    verifyAnchors(ctx, ctx.pendingAnchors)
    return
  }
  let engine = createTextAnchorEngine(anchorRoot(ctx))
  if (engine.text === ctx.measuredText) {
    // Ranges are live DOM objects: rebuild even for equal-value node replacement.
    ctx.win.clearTimeout(ctx.resolveTimer)
    ctx.resolveStartedAt = 0
    applyHighlights(ctx, ctx.pendingHighlights, engine)
    verifyAnchors(ctx, ctx.pendingAnchors, engine)
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
        applyHighlights(ctx, ctx.pendingHighlights, engine)
        verifyAnchors(ctx, ctx.pendingAnchors, engine)
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
  if (
    rootReplaced ||
    records.some(function (record) {
      return (
        record.type === 'attributes' &&
        (record.attributeName === 'data-anchor-ignore' ||
          record.attributeName === 'data-comment-ui' ||
          record.attributeName === 'class')
      )
    })
  )
    ctx.anchorSnapshotGeneration++
  if (
    !root ||
    !ctx.doc.body ||
    (!ctx.pendingHighlights.length && !ctx.pendingAnchors.length)
  )
    return
  let relevant = records.filter(function (record) {
    if (record.type !== 'attributes' && !root.contains(record.target))
      return false
    let element =
      record.target.nodeType === 1
        ? (record.target as Element)
        : record.target.parentElement
    if (
      element &&
      element.closest('[data-anchor-ignore],#ash-comment-highlight-style')
    )
      return false
    if (
      record.type === 'childList' &&
      Array.from(record.addedNodes)
        .concat(Array.from(record.removedNodes))
        .every(function (node) {
          return (
            node.nodeType === 1 &&
            ((node as Element).hasAttribute('data-anchor-ignore') ||
              (node as Element).id === 'ash-comment-highlight-style')
          )
        })
    )
      return false
    return true
  })
  if (!rootReplaced && !relevant.length) return
  // Layout changes never alter anchor text, but live range geometry may change.
  schedulePositionBadges(ctx)
  if (
    rootReplaced ||
    relevant.some(function (record) {
      return record.type !== 'attributes'
    })
  ) {
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
