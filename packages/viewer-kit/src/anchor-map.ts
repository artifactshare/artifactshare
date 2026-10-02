import { MAX_ANCHOR_TEXT_UNITS, type AnchorDocument } from './anchor-text.js'

export { MAX_ANCHOR_TEXT_UNITS }
export const MAX_ANCHOR_FRONTIER_STEPS = 250_000
export interface MatchRun {
  oldStart: number
  newStart: number
  length: number
}
export interface AnchorTransition {
  matches: MatchRun[]
  invalid: Array<{ start: number; end: number; reason: string }>
  scannedUnits: number
  frontierSteps: number
}
export type AnchorPosition =
  | { textStart: number; textEnd: number }
  | { reason: string }
const content = (text: string) => /[^\p{P}\p{Z}\s]/u.test(text)

/** A transition is independent of the number and ordering of comments. */
export function buildAnchorTransition(
  before: AnchorDocument,
  after: AnchorDocument,
  budget = MAX_ANCHOR_FRONTIER_STEPS,
): AnchorTransition | null {
  const a = before.text,
    b = after.text
  if (a.length > MAX_ANCHOR_TEXT_UNITS || b.length > MAX_ANCHOR_TEXT_UNITS)
    return null
  const result: AnchorTransition = {
    matches: [],
    invalid: [],
    scannedUnits: 0,
    frontierSteps: 0,
  }
  let prefix = 0
  while (prefix < a.length && prefix < b.length) {
    result.scannedUnits++
    if (a.charCodeAt(prefix) !== b.charCodeAt(prefix)) break
    prefix++
  }
  let suffix = 0
  while (suffix < a.length - prefix && suffix < b.length - prefix) {
    result.scannedUnits++
    if (
      a.charCodeAt(a.length - suffix - 1) !==
      b.charCodeAt(b.length - suffix - 1)
    )
      break
    suffix++
  }
  function add(oldStart: number, newStart: number, length: number) {
    if (!length) return
    const last = result.matches.at(-1)
    if (
      last &&
      last.oldStart + last.length === oldStart &&
      last.newStart + last.length === newStart
    )
      last.length += length
    else result.matches.push({ oldStart, newStart, length })
  }
  function spend() {
    return ++result.frontierSteps <= budget
  }
  function myers(as: number, ae: number, bs: number, be: number): boolean {
    const n = ae - as,
      m = be - bs
    if (!n || !m) return true
    let frontier = new Map<number, number>([[1, 0]])
    const trace: Map<number, number>[] = []
    for (let d = 0; d <= n + m; d++) {
      const next = new Map<number, number>()
      for (let k = -d; k <= d; k += 2) {
        if (!spend()) return false
        const left = frontier.get(k - 1) ?? -Infinity
        const right = frontier.get(k + 1) ?? -Infinity
        let x = k === -d || (k !== d && left < right) ? right : left + 1
        let y = x - k
        while (
          x < n &&
          y < m &&
          a.charCodeAt(as + x) === b.charCodeAt(bs + y)
        ) {
          if (!spend()) return false
          x++
          y++
        }
        next.set(k, x)
        if (x >= n && y >= m) {
          const backwards: MatchRun[] = []
          for (let depth = d; depth >= 0; depth--) {
            const prior = depth ? trace[depth - 1]! : new Map([[1, 0]])
            const diagonal = x - y
            const l = prior.get(diagonal - 1) ?? -Infinity
            const r = prior.get(diagonal + 1) ?? -Infinity
            const previousK =
              diagonal === -depth || (diagonal !== depth && l < r)
                ? diagonal + 1
                : diagonal - 1
            const previousX = prior.get(previousK) ?? 0
            const previousY = previousX - previousK
            const endX = x
            while (x > previousX && y > previousY) {
              x--
              y--
            }
            if (endX > x)
              backwards.push({
                oldStart: as + x,
                newStart: bs + y,
                length: endX - x,
              })
            x = previousX
            y = previousY
          }
          for (const run of backwards.reverse())
            add(run.oldStart, run.newStart, run.length)
          return true
        }
      }
      trace.push(next)
      frontier = next
    }
    return false
  }
  function lines(start: number, end: number, text: string) {
    const entries: Array<{ text: string; start: number; end: number }> = []
    let at = start
    while (at < end) {
      let next = at
      while (next < end) {
        result.scannedUnits++
        if (text[next++] === '\n') break
      }
      entries.push({ text: text.slice(at, next), start: at, end: next })
      at = next
    }
    return entries
  }
  add(0, 0, prefix)
  const ae = a.length - suffix,
    be = b.length - suffix
  if (
    a.slice(prefix, ae).includes('\n') &&
    b.slice(prefix, be).includes('\n')
  ) {
    const al = lines(prefix, ae, a),
      bl = lines(prefix, be, b)
    if (!al || !bl) return null
    const unique = (entries: typeof al) => {
      const map = new Map<string, number>()
      entries.forEach((line, index) =>
        map.set(line.text, map.has(line.text) ? -1 : index),
      )
      return map
    }
    const ai = unique(al),
      bi = unique(bl)
    const pairs: Array<{ a: number; b: number; parent: number }> = []
    const tails: number[] = []
    for (let i = 0; i < al.length; i++) {
      const j = bi.get(al[i]!.text)
      if (ai.get(al[i]!.text) !== i || j === undefined || j < 0) continue
      // Already increasing lines extend the patience chain in constant time.
      // In particular, two distant edits must not charge an O(lines log lines)
      // frontier search for the unchanged middle between them.
      let lo = tails.length,
        hi = tails.length
      if (tails.length && pairs[tails[tails.length - 1]!]!.b >= j) lo = 0
      while (lo < hi) {
        if (!spend()) return null
        const mid = (lo + hi) >>> 1
        if (pairs[tails[mid]!]!.b < j) lo = mid + 1
        else hi = mid
      }
      pairs.push({ a: i, b: j, parent: lo ? tails[lo - 1]! : -1 })
      tails[lo] = pairs.length - 1
    }
    const aligned: typeof pairs = []
    for (let at = tails.at(-1) ?? -1; at >= 0; at = pairs[at]!.parent)
      aligned.push(pairs[at]!)
    let x = prefix,
      y = prefix
    for (const pair of aligned.reverse()) {
      const left = al[pair.a]!,
        right = bl[pair.b]!
      if (!myers(x, left.start, y, right.start)) return null
      add(left.start, right.start, left.end - left.start)
      x = left.end
      y = right.end
    }
    if (!myers(x, ae, y, be)) return null
  } else if (!myers(prefix, ae, prefix, be)) return null
  add(ae, be, suffix)

  // Duplicate safety is a property of the entire transition, not of the
  // commented occurrence. Ids and neighboring blocks do not establish moves.
  function occurrences(doc: AnchorDocument) {
    const groups = new Map<string, typeof doc.blocks>()
    for (const block of doc.blocks) {
      const value = doc.text.slice(block.start, block.end)
      if (!value.trim()) continue
      const group = groups.get(value) ?? []
      group.push(block)
      groups.set(value, group)
    }
    result.scannedUnits += doc.text.length
    return groups
  }
  const old = occurrences(before),
    next = occurrences(after)
  const targets = new Map(after.blocks.map((block) => [block.start, block.end]))
  const changed = new Set<string>()
  for (const [value, copies] of old) {
    const count = next.get(value)?.length ?? 0
    if (Math.max(copies.length, count) >= 2 && copies.length !== count)
      changed.add(value)
  }
  // Both sides of boundary insertions remain eligible for duplicate guards.
  // Paragraph splits and joins alone do not invalidate surviving characters.
  function boundary(offset: number): number[] {
    let lo = 0,
      hi = result.matches.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      const run = result.matches[mid]!
      if (run.oldStart + run.length < offset) lo = mid + 1
      else hi = mid
    }
    const run = result.matches[lo]
    if (run && run.oldStart < offset && offset < run.oldStart + run.length)
      return [run.newStart + offset - run.oldStart]
    const previous =
      run && run.oldStart + run.length === offset ? run : result.matches[lo - 1]
    const following = previous === run ? result.matches[lo + 1] : run
    return [
      previous ? previous.newStart + previous.length : 0,
      following ? following.newStart : b.length,
    ]
  }
  let runIndex = 0
  for (const block of before.blocks) {
    while (
      runIndex < result.matches.length &&
      result.matches[runIndex]!.oldStart + result.matches[runIndex]!.length <=
        block.start
    )
      runIndex++
    const value = a.slice(block.start, block.end)
    if (!value.trim()) continue
    if (Math.max(old.get(value)!.length, next.get(value)?.length ?? 0) >= 2) {
      // A single retained run means no hunk touches the interior. Its delta
      // includes all preceding hunks and excludes insertions at either edge.
      const kept = result.matches[runIndex]
      const shiftedStart = kept && kept.newStart + block.start - kept.oldStart
      if (
        !kept ||
        kept.oldStart > block.start ||
        kept.oldStart + kept.length < block.end ||
        targets.get(shiftedStart!) !== shiftedStart! + block.end - block.start
      )
        changed.add(value)
    }
    const starts = boundary(block.start),
      ends = boundary(block.end)
    let hasContent = false
    for (let i = runIndex; i < result.matches.length; i++) {
      const run = result.matches[i]!
      if (run.oldStart >= block.end) break
      const start = Math.max(block.start, run.oldStart),
        end = Math.min(block.end, run.oldStart + run.length)
      if (start < end && content(a.slice(start, end))) {
        hasContent = true
        break
      }
    }
    if (!hasContent && content(a.slice(block.start, block.end)))
      result.invalid.push({ ...block, reason: 'replaced-block' })
    else {
      const kept = result.matches[runIndex]
      const previous = result.matches[runIndex - 1]
      const following = result.matches[runIndex + 1]
      const entireBlockKept =
        kept &&
        kept.oldStart <= block.start &&
        kept.oldStart + kept.length >= block.end
      // A deleted block must not inherit a matching suffix/prefix from its
      // neighbor. This requires an actual deleted copy at the boundary;
      // changing only paragraph ownership still follows the character diff.
      const deletedBefore =
        entireBlockKept &&
        kept.oldStart === block.start &&
        block.start - (previous ? previous.oldStart + previous.length : 0) >=
          value.length &&
        a.slice(block.start - value.length, block.start) === value
      const deletedAfter =
        entireBlockKept &&
        kept.oldStart + kept.length === block.end &&
        (following ? following.oldStart : a.length) - block.end >=
          value.length &&
        a.slice(block.end, block.end + value.length) === value
      if (
        (deletedBefore || deletedAfter) &&
        !starts.some((start) => {
          const target = targets.get(start)
          return (
            target !== undefined && (target === ends[0] || target === ends[1])
          )
        })
      )
        result.invalid.push({ ...block, reason: 'block-boundary-changed' })
    }
  }
  for (const value of changed)
    for (const block of old.get(value)!)
      result.invalid.push({ ...block, reason: 'duplicate-changed' })
  result.invalid.sort(
    (x, y) =>
      x.start - y.start ||
      Number(y.reason === 'duplicate-changed') -
        Number(x.reason === 'duplicate-changed'),
  )
  const merged: AnchorTransition['invalid'] = []
  for (const invalid of result.invalid) {
    const last = merged.at(-1)
    if (last && last.end > invalid.start)
      last.end = Math.max(last.end, invalid.end)
    else merged.push(invalid)
  }
  result.invalid = merged
  return result
}

export function mapAnchorRange(
  map: AnchorTransition,
  start: number,
  end: number,
): AnchorPosition {
  let first = 0,
    last = map.invalid.length
  while (first < last) {
    const middle = (first + last) >>> 1
    if (map.invalid[middle]!.end <= start) first = middle + 1
    else last = middle
  }
  const invalid = map.invalid[first]
  if (invalid && invalid.start < end) return { reason: invalid.reason }
  let lo = 0,
    hi = map.matches.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1,
      run = map.matches[mid]!
    if (run.oldStart + run.length <= start) lo = mid + 1
    else hi = mid
  }
  let textStart: number | null = null,
    textEnd = 0
  for (let i = lo; i < map.matches.length; i++) {
    const run = map.matches[i]!
    if (run.oldStart >= end) break
    const from = Math.max(start, run.oldStart),
      to = Math.min(end, run.oldStart + run.length)
    if (from < to) {
      textStart ??= run.newStart + from - run.oldStart
      textEnd = run.newStart + to - run.oldStart
    }
  }
  return textStart === null
    ? { reason: 'deleted-or-replaced' }
    : { textStart, textEnd }
}
