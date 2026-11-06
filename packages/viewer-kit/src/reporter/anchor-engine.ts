import { textHash } from './text-hash.js'
import type { capturePrimordials } from './primordials.js'

// Keep owned strings local and expose narrow accessors so bundling cannot
// duplicate literals by inlining exported constants into their consumers.
const ANCHOR_IGNORE_ATTRIBUTE = 'data-anchor-ignore'
const COMMENT_UI_ATTRIBUTE = 'data-comment-ui'
export const EXCLUSION_CLASS_ATTRIBUTE = 'class'
const HIGHLIGHT_STYLE_ID = 'ash-comment-highlight-style'
const TEXT_ANCHOR_EXCLUDED_SELECTOR =
  'script,style,noscript,template,textarea,select,[' +
  ANCHOR_IGNORE_ATTRIBUTE +
  '],[' +
  COMMENT_UI_ATTRIBUTE +
  '],.ash-comment-highlight-badge,.mermaid-diagram'
const IGNORED_MUTATION_SELECTOR =
  '[' + ANCHOR_IGNORE_ATTRIBUTE + '],#' + HIGHLIGHT_STYLE_ID
const COMMENT_UI_SELECTOR = '[' + COMMENT_UI_ATTRIBUTE + ']'

export function anchorIgnoreAttribute() {
  return ANCHOR_IGNORE_ATTRIBUTE
}
export function commentUiAttribute() {
  return COMMENT_UI_ATTRIBUTE
}
export function highlightStyleId() {
  return HIGHLIGHT_STYLE_ID
}
export function ignoredMutationSelector() {
  return IGNORED_MUTATION_SELECTOR
}
export function commentUiSelector() {
  return COMMENT_UI_SELECTOR
}

export interface TextSelector {
  quotedText: string
  prefixText?: string | null
  suffixText?: string | null
  selectorFormat?: string | null
  textStart?: number | null
  textEnd?: number | null
  textHash?: string | null
  ambiguousAtCreation?: boolean | null
}
interface TextUnit {
  node: Node
  start: number
  end: number
}
export type TextAnchorEngine = ReturnType<typeof createTextAnchorEngine>

export function createTextAnchorEngine(
  root: Element,
  strings: Pick<
    ReturnType<typeof capturePrimordials>,
    | 'stringReplace'
    | 'stringTrim'
    | 'stringSlice'
    | 'createRange'
    | 'rangeSetStart'
    | 'rangeSetEnd'
    | 'rangeCollapse'
    | 'rangeComparePoint'
  > = {
    stringReplace: (value, pattern, replacement) =>
      value.replace(pattern, replacement),
    stringTrim: (value) => value.trim(),
    stringSlice: (value, start, end) => value.slice(start, end),
    createRange: (document) => document.createRange(),
    rangeSetStart: (range, node, offset) => range.setStart(node, offset),
    rangeSetEnd: (range, node, offset) => range.setEnd(node, offset),
    rangeCollapse: (range, toStart) => range.collapse(toStart),
    rangeComparePoint: (range, node, offset) =>
      range.comparePoint(node, offset),
  },
) {
  const document = root.ownerDocument
  const units: TextUnit[][] = []
  let text = ''
  let previousBlock: Element | null = null
  // Initialize without authored String.split or Array iterator hooks.
  const blockTagNames =
    'p div li ul ol dl dt dd h1 h2 h3 h4 h5 h6 pre blockquote table thead tbody tfoot tr td th caption section article aside header footer nav main figure figcaption details summary hr br address form fieldset'
  const blockTags = new Set<string>()
  let blockTag = ''
  for (let i = 0; i <= blockTagNames.length; i++) {
    if (i === blockTagNames.length || blockTagNames[i] === ' ') {
      blockTags.add(blockTag)
      blockTag = ''
    } else blockTag += blockTagNames[i]
  }
  const walker = document.createTreeWalker(root, 4 | 1)
  let node
  while ((node = walker.nextNode())) {
    const element = node.nodeType === 1 ? (node as Element) : node.parentElement
    if (!element || element.closest(TEXT_ANCHOR_EXCLUDED_SELECTOR)) continue
    if (node.nodeType === 1) {
      // Void boundaries have no text children for the block comparison below.
      if (
        ((node as Element).localName === 'br' ||
          (node as Element).localName === 'hr') &&
        text &&
        !text.endsWith(' ')
      ) {
        text += ' '
        units.push([])
      }
      continue
    }
    const parent = node.parentElement
    let block = parent
    while (block && block !== root && !blockTags.has(block.localName))
      block = block.parentElement
    if (text && previousBlock !== block && !text.endsWith(' ')) {
      text += ' '
      units.push([])
    }
    previousBlock = block
    const value = node.nodeValue || ''
    for (let offset = 0; offset < value.length; offset++) {
      const segment = { node: node, start: offset, end: offset + 1 }
      if (/\s/.test(value[offset]!)) {
        if (!text) continue
        if (text.endsWith(' ')) units[units.length - 1]!.push(segment)
        else {
          text += ' '
          units.push([segment])
        }
      } else {
        text += value[offset]!
        units.push([segment])
      }
    }
  }
  const hash = textHash(text)
  function hits(haystack: string, needle: string) {
    const found = []
    if (needle)
      for (
        let at = haystack.indexOf(needle);
        at >= 0;
        at = haystack.indexOf(needle, at + 1)
      )
        found.push(at)
    return found
  }
  function normalizedQuote(selector: TextSelector) {
    return selector.selectorFormat === 'normalized-v1'
      ? selector.quotedText
      : selector.quotedText.replace(/\s+/g, ' ').trim()
  }
  function resolve(selector: TextSelector) {
    if (
      !selector ||
      typeof selector.quotedText !== 'string' ||
      (selector.prefixText != null &&
        typeof selector.prefixText !== 'string') ||
      (selector.suffixText != null && typeof selector.suffixText !== 'string')
    )
      return null
    const modern = selector.selectorFormat === 'normalized-v1'
    const legacy = !selector.selectorFormat
    const normalize = (value: string) =>
      modern
        ? value
        : legacy
          ? value.replace(/\s+/g, ' ').trim()
          : value.replace(/\s+/g, ' ')
    const quote = normalizedQuote(selector)
    const prefix = normalize(selector.prefixText || '')
    const suffix = normalize(selector.suffixText || '')
    if (!quote.trim()) return null
    if (legacy || selector.selectorFormat === 'quote-v1') {
      // Old writers trimmed context edges, and agents pass context as the
      // text just before/after the quote. Restore only those joins, never
      // guess at missing separators inside context (e.g. old block text 'ab').
      const positions = new Set<number>()
      for (const before of prefix && !prefix.endsWith(' ') ? ['', ' '] : [''])
        for (const after of suffix && !suffix.startsWith(' ')
          ? ['', ' ']
          : [''])
          for (const at of hits(text, prefix + before + quote + after + suffix))
            positions.add(at + prefix.length + before.length)
      if (positions.size !== 1) return null
      const start = positions.values().next().value!
      return { textStart: start, textEnd: start + quote.length }
    }
    const matches = hits(text, prefix + quote + suffix)
    const hit = matches.length === 1 ? matches[0]! + prefix.length : -1
    const context = prefix + quote + suffix
    const start = selector.textStart,
      end = selector.textEnd
    if (
      modern &&
      typeof start === 'number' &&
      Number.isInteger(start) &&
      typeof end === 'number' &&
      Number.isInteger(end) &&
      start >= prefix.length &&
      end - start === quote.length &&
      text.slice(start, end) === quote &&
      text.slice(start - prefix.length, end + suffix.length) === context &&
      (hit >= 0 || selector.textHash === hash)
    )
      return { textStart: start, textEnd: end }
    if (hit >= 0 && !selector.ambiguousAtCreation)
      return {
        textStart: hit,
        textEnd: hit + quote.length,
      }
    return null
  }
  function ranges(start: number, end: number) {
    const segments: TextUnit[] = []
    for (const unit of units.slice(start, end))
      for (const segment of unit) {
        const last = segments[segments.length - 1]
        if (last && last.node === segment.node && last.end === segment.start)
          last.end = segment.end
        else segments.push({ ...segment })
      }
    return segments.map((segment) => {
      const range = strings.createRange(document)
      strings.rangeSetStart(range, segment.node, segment.start)
      strings.rangeSetEnd(range, segment.node, segment.end)
      return range
    })
  }
  // Reverse index for live painted endpoints: one document pass, then constant
  // time endpoint lookup per comment, including inserts between painted pieces.
  const sourceIndexes = new WeakMap<Node, number[]>()
  const sourceSegments: { segment: TextUnit; index: number }[] = []
  units.forEach((segments, index) => {
    for (const segment of segments) {
      sourceSegments.push({ segment, index })
      let offsets = sourceIndexes.get(segment.node)
      if (!offsets) sourceIndexes.set(segment.node, (offsets = []))
      offsets[segment.start] = index
    }
  })
  function paintedText(
    first: Pick<Range, 'startContainer' | 'startOffset'>,
    last: Pick<Range, 'endContainer' | 'endOffset'>,
  ) {
    const start = sourceIndexes.get(first.startContainer)?.[first.startOffset]
    const end = sourceIndexes.get(last.endContainer)?.[last.endOffset - 1]
    return start === undefined || end === undefined || start > end
      ? null
      : text.slice(start, end + 1).trim()
  }
  function mappedSlice(range: Range) {
    if (
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer) ||
      range.collapsed
    )
      return null
    // Text endpoints use the existing reverse index. Element endpoints and
    // excluded gaps use binary search in document order, not a character scan.
    function boundary(boundaryNode: Node, offset: number, isEnd: boolean) {
      const direct =
        sourceIndexes.get(boundaryNode)?.[isEnd ? offset - 1 : offset]
      if (direct !== undefined) return direct + (isEnd ? 1 : 0)
      const point = strings.createRange(document)
      strings.rangeSetStart(point, boundaryNode, offset)
      strings.rangeCollapse(point, true)
      let low = 0,
        high = sourceSegments.length
      while (low < high) {
        const mid = (low + high) >>> 1
        const entry = sourceSegments[mid]!
        const comparison = strings.rangeComparePoint(
          point,
          entry.segment.node,
          isEnd ? entry.segment.start : entry.segment.end,
        )
        if (isEnd ? comparison < 0 : comparison <= 0) low = mid + 1
        else high = mid
      }
      return isEnd
        ? low
          ? sourceSegments[low - 1]!.index + 1
          : 0
        : low < sourceSegments.length
          ? sourceSegments[low]!.index
          : text.length
    }
    let start = boundary(range.startContainer, range.startOffset, false)
    let end = boundary(range.endContainer, range.endOffset, true)
    while (start >= 0 && start < end && /\s/.test(text[start]!)) start++
    while (end > start && /\s/.test(text[end - 1]!)) end--
    if (start < 0 || start >= end || end - start > 1000) return null
    return {
      textStart: start,
      textEnd: end,
      quotedText: strings.stringSlice(text, start, end),
    }
  }
  // Creation-only context: never participates in resolution or painting.
  function locus(range: Range) {
    const mapped = mappedSlice(range)
    if (!mapped) return undefined
    const path: { rank: number; element: Element }[] = []
    // A fresh range starts collapsed; moving its start also moves its end.
    // Never clone the live selection through a page-replaceable method.
    const startPoint = strings.createRange(document)
    strings.rangeSetStart(startPoint, range.startContainer, range.startOffset)
    const candidates = root.querySelectorAll('h1,h2,h3,h4,h5,h6')
    for (let i = 0; i < candidates.length; i++) {
      const heading = candidates[i]!
      if (strings.rangeComparePoint(startPoint, heading, 0) > 0) break
      if (
        heading.namespaceURI !== 'http://www.w3.org/1999/xhtml' ||
        heading.closest(TEXT_ANCHOR_EXCLUDED_SELECTOR)
      )
        continue
      const rank = Number(heading.localName[1])
      while (path.length && path[path.length - 1]!.rank >= rank) path.length--
      path[path.length] = { rank, element: heading }
    }
    // Read only the final (at most six) labels, even for nested heading DOM.
    const headings: string[] = []
    for (let i = 0; i < path.length; i++) {
      headings[i] = strings.stringSlice(
        strings.stringTrim(
          strings.stringReplace(
            path[i]!.element.textContent || '',
            /\s+/g,
            ' ',
          ),
        ),
        0,
        120,
      )
    }
    let block =
      range.commonAncestorContainer.nodeType === 1
        ? (range.commonAncestorContainer as Element)
        : range.commonAncestorContainer.parentElement
    while (block && block !== root && !blockTags.has(block.localName))
      block = block.parentElement
    block = block || root
    const nodes = document.createTreeWalker(block, 4)
    let first: number | undefined
    let last: number | undefined
    let blockNode: Node | null
    while ((blockNode = nodes.nextNode())) {
      const offsets = sourceIndexes.get(blockNode)
      if (!offsets) continue
      // Sparse leading whitespace has no mapped index.
      let start: number | undefined
      for (let i = 0; i < offsets.length; i++) {
        if (offsets[i] !== undefined) {
          start = offsets[i]
          break
        }
      }
      if (start === undefined) continue
      first ??= start
      last = offsets[offsets.length - 1]! + 1
    }
    if (first === undefined || last === undefined) return undefined
    const start = Math.max(
      first,
      Math.min(
        Math.floor((mapped.textStart + mapped.textEnd) / 2) - 300,
        last - 600,
      ),
    )
    return {
      headings,
      block_text: strings.stringSlice(text, start, Math.min(last, start + 600)),
    }
  }
  function describe(range: Range) {
    const mapped = mappedSlice(range)
    if (!mapped) return null
    const { textStart: start, textEnd: end, quotedText: quote } = mapped
    let prefix = '',
      suffix = '',
      ambiguous = true
    for (let size = 32; ; size = Math.min(400, size + 32)) {
      prefix = strings.stringSlice(text, Math.max(0, start - size), start)
      suffix = strings.stringSlice(text, end, end + size)
      ambiguous = hits(text, prefix + quote + suffix).length !== 1
      if (!ambiguous || size === 400) break
    }
    return {
      quotedText: quote,
      prefixText: prefix,
      suffixText: suffix,
      textStart: start,
      textEnd: end,
      textHash: hash,
      selectorFormat: 'normalized-v1',
      ambiguousAtCreation: ambiguous,
    }
  }
  return {
    text,
    hash,
    describe,
    mappedSlice,
    locus,
    resolve,
    ranges,
    paintedText,
    normalizedQuote,
  }
}
