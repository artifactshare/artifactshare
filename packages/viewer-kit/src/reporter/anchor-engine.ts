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

export function anchorExclusions() {
  return {
    tags: ['script', 'style', 'noscript', 'template', 'textarea', 'select'],
    attributes: ['data-anchor-ignore', 'data-comment-ui'],
    classes: ['ash-comment-highlight-badge', 'mermaid-diagram'],
  }
}

export function anchorExclusionDependencies(exclusions = anchorExclusions()) {
  return {
    selector: exclusions.tags
      .concat(
        exclusions.attributes.map((name) => '[' + name + ']'),
        exclusions.classes.map((name) => '.' + name),
      )
      .join(','),
    attributes: exclusions.attributes.concat(
      exclusions.classes.length ? ['class'] : [],
    ),
  }
}

export function createTextAnchorEngine(root: Element) {
  const document = root.ownerDocument
  const units: TextUnit[][] = []
  let text = ''
  let previousBlock: Element | null = null
  const excluded = anchorExclusionDependencies().selector
  const blockTags = new Set(
    'p div li ul ol dl dt dd h1 h2 h3 h4 h5 h6 pre blockquote table thead tbody tfoot tr td th caption section article aside header footer nav main figure figcaption details summary hr br address form fieldset'.split(
      ' ',
    ),
  )
  const walker = document.createTreeWalker(root, 4 | 1)
  let node
  while ((node = walker.nextNode())) {
    const element = node.nodeType === 1 ? (node as Element) : node.parentElement
    if (!element || element.closest(excluded)) continue
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
  // Synchronous SHA-256 binds the text snapshot to its ranges without async races.
  function textHash(value: string) {
    const bytes = new TextEncoder().encode(value)
    const words = new Uint32Array(Math.ceil((bytes.length + 9) / 64) * 16)
    for (let i = 0; i < bytes.length; i++)
      words[i >>> 2] = words[i >>> 2]! | (bytes[i]! << (24 - (i % 4) * 8))
    words[bytes.length >>> 2] =
      words[bytes.length >>> 2]! | (0x80 << (24 - (bytes.length % 4) * 8))
    words[words.length - 2] = Math.floor(bytes.length / 0x20000000)
    words[words.length - 1] = bytes.length * 8
    const h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19,
    ]
    const k = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
      0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
      0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
      0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
      0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
      0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
      0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
      0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
      0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]
    const rotate = (x: number, n: number) => (x >>> n) | (x << (32 - n))
    const w = new Uint32Array(64)
    for (let offset = 0; offset < words.length; offset += 16) {
      for (let i = 0; i < 64; i++) {
        if (i < 16) w[i] = words[offset + i]!
        else {
          const x = w[i - 15]!,
            y = w[i - 2]!
          w[i] =
            w[i - 16]! +
            (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
            w[i - 7]! +
            (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))
        }
      }
      let [a, b, c, d, e, f, g, j] = h as [
        number,
        number,
        number,
        number,
        number,
        number,
        number,
        number,
      ]
      for (let i = 0; i < 64; i++) {
        const t1 =
          (j +
            (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
            ((e & f) ^ (~e & g)) +
            k[i]! +
            w[i]!) |
          0
        const t2 =
          ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) +
            ((a & b) ^ (a & c) ^ (b & c))) |
          0
        j = g
        g = f
        f = e
        e = (d + t1) | 0
        d = c
        c = b
        b = a
        a = (t1 + t2) | 0
      }
      const next = [a, b, c, d, e, f, g, j]
      for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) | 0
    }
    return h.map((word) => (word >>> 0).toString(16).padStart(8, '0')).join('')
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
      const range = document.createRange()
      range.setStart(segment.node, segment.start)
      range.setEnd(segment.node, segment.end)
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
      const point = document.createRange()
      point.setStart(boundaryNode, offset)
      point.collapse(true)
      let low = 0,
        high = sourceSegments.length
      while (low < high) {
        const mid = (low + high) >>> 1
        const entry = sourceSegments[mid]!
        const comparison = point.comparePoint(
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
      quotedText: text.slice(start, end),
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
      prefix = text.slice(Math.max(0, start - size), start)
      suffix = text.slice(end, end + size)
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
    resolve,
    ranges,
    paintedText,
    normalizedQuote,
  }
}
