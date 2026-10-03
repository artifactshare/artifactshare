import type { ReporterState } from './state.js'
import { send } from './messaging.js'
import { schedulePositionBadges } from './badges.js'

export function requestMermaidRendering(ctx: ReporterState) {
  if (ctx.mermaidRequested) return
  if (!ctx.doc.body || !ctx.doc.body.hasAttribute('data-artifact-markdown'))
    return
  let blocks = ctx.doc.querySelectorAll('pre code.language-mermaid')
  let diagrams = []
  for (let index = 0; index < blocks.length && diagrams.length < 16; index++) {
    let source = blocks[index].textContent || ''
    if (!source || source.length > 20000) continue
    let pre = blocks[index].closest('pre')
    if (!pre) continue
    let id = 'artifactshare-mermaid-' + index
    ctx.mermaidBlocks[id] = pre
    diagrams.push({ id: id, source: source })
  }
  if (diagrams.length) {
    ctx.mermaidRequested = true
    send(ctx, {
      kind: 'mermaid-render-request',
      renderToken: ctx.readyChallenge,
      diagrams: diagrams,
    })
  }
}

export function installMermaidResults(
  ctx: ReporterState,
  renderToken: string,
  results: { id: string; svg: string }[],
) {
  if (renderToken !== ctx.readyChallenge) return
  if (!Array.isArray(results)) return
  for (let index = 0; index < results.length; index++) {
    let result = results[index] || {}
    let pre =
      typeof result.id === 'string' ? ctx.mermaidBlocks[result.id] : null
    if (
      !pre ||
      typeof result.svg !== 'string' ||
      !result.svg.startsWith('<svg')
    )
      continue
    let svgDocument = new ctx.win.DOMParser().parseFromString(
      result.svg,
      'image/svg+xml',
    )
    let svg = svgDocument.documentElement
    if (
      svg.localName !== 'svg' ||
      svg.namespaceURI !== 'http://www.w3.org/2000/svg' ||
      svgDocument.querySelector('parsererror')
    )
      continue
    let container = ctx.doc.createElement('div')
    container.className = 'mermaid-diagram'
    container.appendChild(ctx.doc.importNode(svg, true))
    pre.dataset.mermaidRendered = 'true'
    pre.hidden = true
    pre.parentNode!.insertBefore(container, pre)
    delete ctx.mermaidBlocks[result.id]
  }
  schedulePositionBadges(ctx)
}
