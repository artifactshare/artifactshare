/** Self-contained anchor engine, injected verbatim so CSP hashes stay stable. */
export const TEXT_ANCHOR_ENGINE_SCRIPT = String.raw`/** Self-contained: serialized into the sandbox, with no runtime imports. */
function createTextAnchorEngine(root) {
  const units = []
  let text = ''
  let previousBlock = null
  const excluded =
    'script,style,noscript,template,textarea,select,[data-anchor-ignore],[data-comment-ui],.ash-comment-highlight-badge,.mermaid-diagram'
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let node
  while ((node = walker.nextNode())) {
    const parent = node.parentElement
    if (!parent || parent.closest(excluded)) continue
    let boxed = parent
    // SVG text can have glyph geometry without a CSS box (notably WebKit).
    // Check its viewport box while still respecting hidden SVG ancestors.
    if (getComputedStyle(parent).visibility === 'hidden' || getComputedStyle(parent).visibility === 'collapse') continue
    while (boxed) {
      const display = getComputedStyle(boxed).display
      if (display !== 'contents' && !(display !== 'none' && boxed.namespaceURI === 'http://www.w3.org/2000/svg' && boxed.localName !== 'svg')) break
      boxed = boxed.parentElement
    }
    if (
      !boxed ||
      !boxed.checkVisibility({
        visibilityProperty: true,
        contentVisibilityAuto: true,
      })
    )
      continue
    let block = parent
    while (
      block &&
      block !== root &&
      /^(inline|contents)/.test(getComputedStyle(block).display)
    )
      block = block.parentElement
    if (text && previousBlock !== block && !text.endsWith(' ')) {
      text += ' '
      units.push([])
    }
    previousBlock = block
    const value = node.nodeValue || ''
    for (let offset = 0; offset < value.length; offset++) {
      const segment = { node: node, start: offset, end: offset + 1 }
      if (/\s/.test(value[offset])) {
        if (!text) continue
        if (text.endsWith(' ')) units[units.length - 1].push(segment)
        else {
          text += ' '
          units.push([segment])
        }
      } else {
        text += value[offset]
        units.push([segment])
      }
    }
  }
  // Synchronous SHA-256 binds the text snapshot to its ranges without async races.
  function textHash(value) {
    const bytes = new TextEncoder().encode(value)
    const words = new Uint32Array(Math.ceil((bytes.length + 9) / 64) * 16)
    for (let i = 0; i < bytes.length; i++)
      words[i >>> 2] |= bytes[i] << (24 - (i % 4) * 8)
    words[bytes.length >>> 2] |= 0x80 << (24 - (bytes.length % 4) * 8)
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
    const rotate = (x, n) => (x >>> n) | (x << (32 - n))
    const w = new Uint32Array(64)
    for (let offset = 0; offset < words.length; offset += 16) {
      for (let i = 0; i < 64; i++) {
        if (i < 16) w[i] = words[offset + i]
        else {
          const x = w[i - 15],
            y = w[i - 2]
          w[i] =
            w[i - 16] +
            (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) +
            w[i - 7] +
            (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))
        }
      }
      let [a, b, c, d, e, f, g, j] = h
      for (let i = 0; i < 64; i++) {
        const t1 =
          (j +
            (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) +
            ((e & f) ^ (~e & g)) +
            k[i] +
            w[i]) |
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
      for (let i = 0; i < 8; i++) h[i] = (h[i] + next[i]) | 0
    }
    return h
      .map((value) => (value >>> 0).toString(16).padStart(8, '0'))
      .join('')
  }
  const hash = textHash(text)
  function unique(needle) {
    if (!needle) return -1
    const first = text.indexOf(needle)
    return first >= 0 && text.indexOf(needle, first + 1) < 0 ? first : -1
  }
  function resolve(selector) {
    if (!selector || typeof selector.quotedText !== 'string' || (selector.prefixText != null && typeof selector.prefixText !== 'string') || (selector.suffixText != null && typeof selector.suffixText !== 'string')) return null
    const modern = selector.selectorFormat === 'normalized-v1'
    const normalize = (value) => (modern ? value : value.replace(/\s+/g, ' '))
    const quote = normalize(selector.quotedText)
    const prefix = normalize(selector.prefixText || '')
    const suffix = normalize(selector.suffixText || '')
    if (!quote) return null
    const context = prefix + quote + suffix
    const hit = unique(context)
    const start = selector.textStart,
      end = selector.textEnd
    if (
      modern &&
      Number.isInteger(start) &&
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
        textStart: hit + prefix.length,
        textEnd: hit + prefix.length + quote.length,
      }
    return null
  }
  function ranges(start, end) {
    const segments = []
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
  function describe(range) {
    if (
      !root.contains(range.startContainer) ||
      !root.contains(range.endContainer) ||
      range.collapsed
    )
      return null
    let start = -1,
      end = -1
    for (let i = 0; i < units.length; i++) {
      const intersects = units[i].some((segment) => {
        const source = document.createRange()
        source.setStart(segment.node, segment.start)
        source.setEnd(segment.node, segment.end)
        return (
          range.compareBoundaryPoints(Range.END_TO_START, source) < 0 &&
          range.compareBoundaryPoints(Range.START_TO_END, source) > 0
        )
      })
      if (intersects) {
        if (start < 0) start = i
        end = i + 1
      }
    }
    while (start >= 0 && start < end && /\s/.test(text[start])) start++
    while (end > start && /\s/.test(text[end - 1])) end--
    if (start < 0 || start >= end || end - start > 1000) return null
    const quote = text.slice(start, end)
    let prefix = '',
      suffix = '',
      ambiguous = true
    for (let size = 32; ; size = Math.min(400, size + 32)) {
      prefix = text.slice(Math.max(0, start - size), start)
      suffix = text.slice(end, end + size)
      ambiguous = unique(prefix + quote + suffix) < 0
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
  return { text, hash, describe, resolve, ranges }
}
`
