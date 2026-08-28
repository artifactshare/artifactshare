import type { MarkdownExtension } from '@tanstack/markdown'

const detailsOpening = /^ {0,3}<details( open)?>\s*$/i
const anyDetailsOpening = /^ {0,3}<details(?:\s[^>]*)?>\s*$/i
const detailsSummary = /^ {0,3}<summary>(.*?)<\/summary>\s*$/i
const detailsClosing = /^ {0,3}<\/details>\s*$/i
const maxDisclosureNesting = 16
const closingDetailsCache = new WeakMap<string[], Map<number, number>>()

type RawHtmlRegion = { kind: 'comment' } | { kind: 'block' }

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
    const cursor = closingDetails(context.lines).get(context.index)
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

function closingDetails(lines: string[]) {
  const cached = closingDetailsCache.get(lines)
  if (cached) return cached

  const closings = new Map<number, number>()
  const openings: Array<{
    index: number
    supported: boolean
    renderable: boolean
    limited: boolean
  }> = []
  let unsupportedDepth = 0
  let limitedDepth = 0
  let ignoredDepth = 0
  let fence: { marker: string; length: number } | undefined
  let rawHtml: RawHtmlRegion | undefined

  for (let cursor = 0; cursor < lines.length; cursor++) {
    const line = lines[cursor] ?? ''
    if (fence) {
      if (isClosingFence(line, fence)) fence = undefined
      continue
    }

    if (rawHtml) {
      if (rawHtml.kind === 'comment' && line.includes('-->'))
        rawHtml = undefined
      else if (rawHtml.kind === 'block' && line.trim() === '')
        rawHtml = undefined
      continue
    }

    const openingFence = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1]
    if (openingFence) {
      fence = { marker: openingFence[0] ?? '', length: openingFence.length }
      continue
    }

    if (anyDetailsOpening.test(line)) {
      const hasSummary = detailsSummary.test(lines[cursor + 1] ?? '')
      if (ignoredDepth > 0 || !isOpeningBoundary(lines, cursor)) {
        ignoredDepth++
        if (hasSummary) cursor++
        continue
      }
      const supported = detailsOpening.test(line) && hasSummary
      const limited =
        limitedDepth > 0 ||
        (supported &&
          unsupportedDepth === 0 &&
          openings.length >= maxDisclosureNesting)
      if (limited && limitedDepth === 0)
        for (const opening of openings) opening.renderable = false
      openings.push({
        index: cursor,
        supported,
        renderable: supported && unsupportedDepth === 0 && !limited,
        limited,
      })
      if (!supported) unsupportedDepth++
      if (limited) limitedDepth++
      if (hasSummary) cursor++
    } else if (detailsClosing.test(line) && ignoredDepth > 0) {
      ignoredDepth--
    } else if (
      detailsClosing.test(line) &&
      (isClosingBoundary(lines, cursor) || openings.at(-1)?.supported === false)
    ) {
      const opening = openings.pop()
      if (opening && !opening.supported) unsupportedDepth--
      if (opening?.limited) limitedDepth--
      if (opening?.renderable) closings.set(opening.index, cursor)
    } else if (/^ {0,3}<!--/u.test(line)) {
      if (!line.includes('-->')) rawHtml = { kind: 'comment' }
    } else if (/^ {0,3}<([A-Za-z][\w:-]*|!--|\/[A-Za-z])/u.test(line)) {
      rawHtml = { kind: 'block' }
    }
  }

  closingDetailsCache.set(lines, closings)
  return closings
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

function isOpeningBoundary(lines: string[], index: number) {
  return index === 0 || (lines[index - 1] ?? '').trim() === ''
}

function isClosingBoundary(lines: string[], index: number) {
  const previous = lines[index - 1] ?? ''
  return previous.trim() === '' || detailsClosing.test(previous)
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#x27;')
}
