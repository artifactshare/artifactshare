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

    const bodyStart = context.index + 2
    const cursor = findClosingDetails(context.lines, bodyStart)
    if (cursor === undefined) return undefined

    context.consume(cursor - context.index + 1)
    return {
      type: 'component',
      name: 'safe-details',
      attributes: {
        summary: summary[1] ?? '',
        open: opening[1] ? 'true' : 'false',
      },
      children: context.parseBlocks(
        context.lines.slice(bodyStart, cursor).join('\n'),
      ),
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

function findClosingDetails(lines: string[], start: number) {
  let depth = 1
  let fence: { marker: string; length: number } | undefined

  for (let cursor = start; cursor < lines.length; cursor++) {
    const line = lines[cursor] ?? ''
    if (fence) {
      if (isClosingFence(line, fence)) fence = undefined
      continue
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]
    if (openingFence) {
      fence = { marker: openingFence[0] ?? '', length: openingFence.length }
      continue
    }

    if (detailsOpening.test(line)) depth++
    else if (detailsClosing.test(line) && --depth === 0) return cursor
  }

  return undefined
}

function isClosingFence(
  line: string,
  fence: { marker: string; length: number },
) {
  const value = line.replace(/^ {0,3}/u, '')
  let length = 0
  while (value[length] === fence.marker) length++
  return length >= fence.length && value.slice(length).trim() === ''
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
}
