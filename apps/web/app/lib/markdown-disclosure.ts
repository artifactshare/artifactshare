import type { MarkdownExtension } from '@tanstack/markdown'

const detailsOpening = /^ {0,3}<details( open)?>\s*$/i
const detailsSummary = /^ {0,3}<summary>(.*?)<\/summary>\s*$/i
const detailsClosing = /^ {0,3}<\/details>\s*$/i

export const markdownDisclosureExtension: MarkdownExtension = {
  name: 'safe-details',
  parseBlock(context) {
    const opening = (context.lines[context.index] ?? '').match(detailsOpening)
    if (!opening) return undefined

    const summary = (context.lines[context.index + 1] ?? '').match(
      detailsSummary,
    )
    if (!summary) return undefined

    const body: string[] = []
    let cursor = context.index + 2
    while (
      cursor < context.lines.length &&
      !detailsClosing.test(context.lines[cursor] ?? '')
    ) {
      body.push(context.lines[cursor] ?? '')
      cursor++
    }
    if (cursor >= context.lines.length) return undefined

    context.consume(cursor - context.index + 1)
    return {
      type: 'component',
      name: 'safe-details',
      attributes: {
        summary: summary[1] ?? '',
        open: opening[1] ? 'true' : 'false',
      },
      children: context.parseBlocks(body.join('\n')),
    }
  },
  renderHtml(node, context) {
    if (node.type !== 'component' || node.name !== 'safe-details')
      return undefined

    const open = node.attributes.open === 'true' ? ' open' : ''
    const summary = escapeHtml(node.attributes.summary ?? '')
    const body = node.children.map(context.renderBlock).join('\n')
    return `<details${open}><summary>${summary}</summary>${body}</details>`
  },
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
}
