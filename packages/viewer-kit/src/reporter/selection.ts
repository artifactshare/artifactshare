import type { ReporterState } from './state.js'
import { send } from './messaging.js'
import { createTextAnchorEngine } from './anchor-engine.js'

export function cssPath(ctx: ReporterState, element: Element | null) {
  if (!element || element.nodeType !== 1) return null
  let parts = []
  while (element && element.nodeType === 1 && element !== ctx.doc.body) {
    let name = element.nodeName.toLowerCase()
    let index = 1
    let sibling: Element | null = element
    while ((sibling = sibling.previousElementSibling)) {
      if (sibling.nodeName.toLowerCase() === name) index++
    }
    parts.unshift(name + ':nth-of-type(' + index + ')')
    element = element.parentElement
  }
  return parts.length ? 'body > ' + parts.join(' > ') : 'body'
}

export function selectedElement(ctx: ReporterState, range: Range) {
  let node = range.commonAncestorContainer
  return (
    (node.nodeType === 1 ? (node as Element) : node.parentElement) ||
    ctx.doc.body
  )
}

export function anchorRoot(ctx: ReporterState) {
  return ctx.doc.querySelector('[data-comment-content]') || ctx.doc.body
}

export function sendSelection(ctx: ReporterState) {
  if (!ctx.textAnchorsEnabled) return
  let selection = ctx.win.getSelection()
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    send(ctx, { kind: 'text-selection-cleared' })
    return
  }
  let range = selection.getRangeAt(0)
  if (!range.toString().trim()) {
    send(ctx, { kind: 'text-selection-cleared' })
    return
  }
  let engine = createTextAnchorEngine(anchorRoot(ctx))
  let selector = engine.describe(range)
  if (!selector) {
    send(ctx, { kind: 'text-selection-cleared' })
    return
  }
  let rect = range.getBoundingClientRect()
  send(ctx, {
    kind: 'text-selection',
    token: ctx.documentToken,
    quotedText: selector.quotedText,
    prefixText: selector.prefixText,
    suffixText: selector.suffixText,
    textStart: selector.textStart,
    textEnd: selector.textEnd,
    selectorFormat: selector.selectorFormat,
    textHash: selector.textHash,
    ambiguousAtCreation: selector.ambiguousAtCreation,
    versionId: ctx.displayedVersionId,
    cssPath: cssPath(ctx, selectedElement(ctx, range)),
    rect: {
      top: rect.top,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    },
  })
}
