import { describe, expect, test } from 'vitest'
import { extractAnchorDocument } from '@artifactshare/viewer-kit/anchor-text'
import {
  buildAnchorTransition,
  mapAnchorRange,
} from './comment-anchor-map.server'

const plain = (text: string) => ({ text, blocks: [] })
describe('source range mapping', () => {
  test.each([
    ['before', 'abcdef', 'XXabcdef', 2, 4, 4, 6, 'cd'],
    ['after', 'abcdef', 'abcdefXX', 2, 4, 2, 4, 'cd'],
    ['start edge', 'abcdef', 'abXXcdef', 2, 4, 4, 6, 'cd'],
    ['end edge', 'abcdef', 'abcdXXef', 2, 4, 2, 4, 'cd'],
    ['inside', 'abcdef', 'abcXXdef', 2, 4, 2, 6, 'cXXd'],
    ['cross start', 'abcdef', 'aXXdef', 2, 5, 3, 5, 'de'],
    ['cross end', 'abcdef', 'abcXXf', 1, 4, 1, 3, 'bc'],
    ['partial deletion', 'abcdef', 'abdef', 1, 5, 1, 4, 'bde'],
    ['partial replacement', 'abcdef', 'abXXef', 1, 5, 1, 5, 'bXXe'],
    ['separate edits', 'abcDEFghi', 'aXcDEFgYi', 3, 6, 3, 6, 'DEF'],
    ['append', 'Hello world.', 'Hello world. Bye.', 6, 12, 6, 12, 'world.'],
    [
      'append paragraph',
      'Hello world.',
      'Hello world.\n\nNext.',
      6,
      12,
      6,
      12,
      'world.',
    ],
    [
      'repeated quote',
      'Hello worldworld',
      'Look! Hello worldworld',
      11,
      16,
      17,
      22,
      'world',
    ],
    ['UTF-16', 'a😀b', 'X a😀b', 1, 3, 3, 5, '😀'],
  ])(
    '%s',
    (_, before, after, start, end, expectedStart, expectedEnd, slice) => {
      const map = buildAnchorTransition(
        plain(before as string),
        plain(after as string),
      )!
      const range = mapAnchorRange(map, start as number, end as number)
      expect(range).toEqual({ textStart: expectedStart, textEnd: expectedEnd })
      expect(
        (after as string).slice(expectedStart as number, expectedEnd as number),
      ).toBe(slice)
    },
  )
  test.each(['abXYef', 'abef', ''])(
    'whole replacement/deletion never finds another quote: %s',
    (after) => {
      const map = buildAnchorTransition(plain('abcdef'), plain(after))!
      expect(mapAnchorRange(map, 2, 4)).toEqual({
        reason: 'deleted-or-replaced',
      })
    },
  )
  test.each([
    [
      'split',
      '<p>Alpha beta gamma</p>',
      '<p>Alpha </p><p>beta gamma</p>',
      6,
      10,
      6,
      10,
    ],
    [
      'split with edit',
      '<p>Alpha beta gamma</p>',
      '<p>Alpha new </p><p>beta gamma</p>',
      6,
      10,
      10,
      14,
    ],
    [
      'join',
      '<p>Alpha </p><p>beta gamma</p>',
      '<p>Alpha beta gamma</p>',
      6,
      10,
      6,
      10,
    ],
    [
      'join with edit',
      '<p>Alpha </p><p>beta gamma</p>',
      '<p>Alpha new beta gamma</p>',
      6,
      10,
      10,
      14,
    ],
    [
      'cross-boundary replacement',
      '<p>Alpha beta</p><p> gamma delta</p>',
      '<p>Alpha NEW delta</p>',
      6,
      22,
      9,
      15,
    ],
  ] as const)(
    '%s keeps surviving text through paragraph boundaries',
    (_name, source, updated, start, end, expectedStart, expectedEnd) => {
      const before = extractAnchorDocument(source)
      const after = extractAnchorDocument(updated)
      const position = mapAnchorRange(
        buildAnchorTransition(before, after)!,
        start,
        end,
      )
      expect(position).toEqual({
        textStart: expectedStart,
        textEnd: expectedEnd,
      })
      expect(after.text.slice(expectedStart, expectedEnd)).toBe(
        _name === 'cross-boundary replacement' ? ' delta' : 'beta',
      )
    },
  )
  test('a deleted paragraph cannot survive as the suffix of another paragraph', () => {
    const before = extractAnchorDocument(
      '<p>Hello world</p><p>world</p><p>End</p>',
    )
    const after = extractAnchorDocument('<p>New: Hello world</p><p>End</p>')
    expect(
      mapAnchorRange(buildAnchorTransition(before, after)!, 11, 16),
    ).toEqual({ reason: 'block-boundary-changed' })
  })
  test('distant edits in a 130k middle charge line scanning separately from search', () => {
    const middle = Array.from(
      { length: 1600 },
      (_, i) => `${i}: ${'content '.repeat(10)}\n`,
    ).join('')
    expect(middle.length).toBeGreaterThan(130_000)
    const before = `first\n${middle}last`
    const after = `new\n${middle}end`
    const map = buildAnchorTransition(plain(before), plain(after))!
    expect(map).not.toBeNull()
    expect(mapAnchorRange(map, 60_000, 60_010)).toEqual({
      textStart: 59_998,
      textEnd: 60_008,
    })
    expect(map.frontierSteps).toBeLessThan(100)
    expect(map.scannedUnits).toBeLessThan(6 * before.length)
  })
  test('two edits and patience lines preserve an untouched span', () => {
    const map = buildAnchorTransition(
      plain('first\nkeep\nlast'),
      plain('new\nkeep\nend'),
    )!
    expect(mapAnchorRange(map, 6, 10)).toEqual({ textStart: 4, textEnd: 8 })
  })
  test.each([250_000, 500_000])(
    'bounded changed-region work for %i units',
    (size) => {
      for (const separator of ['', '\n']) {
        const before = ('abcdefghij' + separator)
          .repeat(Math.ceil(size / (10 + separator.length)))
          .slice(0, size)
        for (const at of [20, size - 20]) {
          const after = before.slice(0, at) + 'X' + before.slice(at)
          const map = buildAnchorTransition(plain(before), plain(after))!
          expect(mapAnchorRange(map, size - 10, size - 5)).toEqual({
            textStart: size - 9,
            textEnd: size - 4,
          })
          expect(map.frontierSteps).toBeLessThan(10)
          expect(map.scannedUnits).toBeLessThan(4 * size + 10)
        }
      }
    },
  )
  test('exhaustion is unresolved; a later complete transition is deterministic', () => {
    expect(buildAnchorTransition(plain('abcd'), plain('wxyz'), 1)).toBeNull()
    expect(buildAnchorTransition(plain('abcd'), plain('wxyz'), 100)).toEqual(
      buildAnchorTransition(plain('abcd'), plain('wxyz'), 1000),
    )
  })
})

const duplicates = (first: string, second: string) =>
  extractAnchorDocument(
    `<p>L</p><p ${first}>X</p><p>R</p><p>L</p><p ${second}>X</p><p>R</p>`,
  )
const paragraphs = (values: string[]) =>
  extractAnchorDocument(values.map((value) => `<p>${value}</p>`).join('\n'))

describe('duplicate count and pure shifts', () => {
  test.each([false, true])(
    'all repeated bystanders survive (reverse: %s)',
    (reverse) => {
      const first = paragraphs(['L', 'Comment here', 'R', 'L', 'R'])
      const second = paragraphs(['L', 'R', 'L', 'Comment here', 'R'])
      const [before, after] = reverse ? [second, first] : [first, second]
      const map = buildAnchorTransition(before, after)!
      for (const value of ['L', 'R']) {
        const sources = before.blocks.filter(
          (block) => before.text.slice(block.start, block.end) === value,
        )
        const targets = after.blocks.filter(
          (block) => after.text.slice(block.start, block.end) === value,
        )
        sources.forEach((block, i) => {
          expect(mapAnchorRange(map, block.start, block.end)).toEqual({
            textStart: targets[i]!.start,
            textEnd: targets[i]!.end,
          })
        })
      }
      const start = before.text.indexOf('Comment here')
      const actual = mapAnchorRange(map, start, start + 12)
      const diffOnly = mapAnchorRange(
        { ...map, invalid: [] },
        start,
        start + 12,
      )
      if ('textStart' in diffOnly) expect(actual).toEqual(diffOnly)
      else expect(actual).toEqual({ reason: 'replaced-block' })
      if ('textStart' in actual)
        expect(after.text.slice(actual.textStart, actual.textEnd)).toBe(
          'Comment here',
        )
    },
  )
  test('unique blocks follow the diff without move detection', () => {
    const before = extractAnchorDocument('<p>A</p><p>Comment here</p><p>B</p>')
    const after = extractAnchorDocument('<p>A</p><p>B</p><p>Comment here</p>')
    expect(
      mapAnchorRange(buildAnchorTransition(before, after)!, 1, 13),
    ).toEqual({
      textStart: 2,
      textEnd: 14,
    })
    expect(after.text.slice(2, 14)).toBe('Comment here')
  })
  test.each([
    ['id="b"', 'id="a"'],
    ['', ''],
    ['id="a"', ''],
    ['id="a"', 'id="a"'],
    ['id="a" data-anchor-generated-id', 'id="b" data-anchor-generated-id'],
  ])('ids do not change an identical republish: %s %s', (a, b) => {
    const before = duplicates('id="a"', 'id="b"'),
      after = duplicates(a, b)
    const map = buildAnchorTransition(before, after)!
    for (const block of before.blocks)
      expect(mapAnchorRange(map, block.start, block.end)).toEqual({
        textStart: block.start,
        textEnd: block.end,
      })
  })
  test.each([
    [
      ['A', 'B', 'A'],
      ['A', 'B', 'A'],
      [0, 4],
    ],
    [
      ['A', 'B', 'A'],
      ['A', 'A', 'B'],
      [0, 2],
    ],
    [['A', 'B', 'A'], ['A', 'B', 'A', 'A'], null],
    [['A', 'B', 'A'], ['A', 'B'], null],
    [['A', 'B'], ['A', 'B', 'A'], null],
    // The long unique block wins the diff; one A is lost. Even the first,
    // untouched A must fail the all-copies pure-shift rule.
    [['A', 'Comment here', 'A'], ['A', 'A', 'Comment here'], null],
  ] as const)(
    'duplicate transition %j -> %j',
    (oldValues, newValues, offsets) => {
      const before = paragraphs([...oldValues]),
        after = paragraphs([...newValues])
      const map = buildAnchorTransition(before, after)!
      const copies = before.blocks.filter(
        (block) => before.text.slice(block.start, block.end) === 'A',
      )
      copies.forEach((block, i) => {
        expect(mapAnchorRange(map, block.start, block.end)).toEqual(
          offsets
            ? { textStart: offsets[i], textEnd: offsets[i]! + 1 }
            : { reason: 'duplicate-changed' },
        )
        if (offsets)
          expect(after.text.slice(offsets[i], offsets[i]! + 1)).toBe('A')
      })
    },
  )
  test('a swap of indistinguishable copies does not require authored identities', () => {
    const before = extractAnchorDocument(
      '<p id="a">A</p><p>B</p><p id="b">A</p>',
    )
    const after = extractAnchorDocument(
      '<p id="b">A</p><p>B</p><p id="a">A</p>',
    )
    const map = buildAnchorTransition(before, after)!
    for (const start of [0, 2])
      expect(mapAnchorRange(map, start, start + 1)).toEqual({
        textStart: start,
        textEnd: start + 1,
      })
  })
  test('unique bystanders follow the diff when duplicates elsewhere change', () => {
    const before = paragraphs(['Start', 'A', 'Comment here', 'A', 'End'])
    const after = paragraphs(['Start', 'A', 'A', 'Comment here', 'End'])
    const map = buildAnchorTransition(before, after)!
    for (const value of ['Start', 'Comment here', 'End']) {
      const start = before.text.indexOf(value),
        target = after.text.indexOf(value)
      expect(mapAnchorRange(map, start, start + value.length)).toEqual({
        textStart: target,
        textEnd: target + value.length,
      })
      expect(after.text.slice(target, target + value.length)).toBe(value)
    }
  })
  test.each([false, true])(
    'keeps untouched text between deletion and insertion of repeated headings (trailing newline: %s)',
    (trailingNewline) => {
      const before = extractAnchorDocument(
        '<h2>Notes</h2>\n<p>Alpha one</p>\n<h2>Notes</h2>\n<p>Beta two</p>\n<p>Cee three</p>' +
          (trailingNewline ? '\n' : ''),
      )
      const after = extractAnchorDocument(
        '<h2>Notes</h2>\n<p>Beta two</p>\n<p>Cee three</p>\n<h2>Notes</h2>\n<p>Delta four</p>' +
          (trailingNewline ? '\n' : ''),
      )
      expect(
        mapAnchorRange(buildAnchorTransition(before, after)!, 22, 30),
      ).toEqual({ textStart: 6, textEnd: 14 })
      expect(after.text.slice(6, 14)).toBe('Beta two')
    },
  )
  test.each([false, true])(
    'section insertion/removal with renumbered ids preserves unchanged comments (reverse: %s)',
    (reverse) => {
      const first = extractAnchorDocument(
        '<h2 id="notes">Notes</h2><p>Alpha para</p><h2 id="notes-1">Notes</h2><p>Beta para</p>',
      )
      const second = extractAnchorDocument(
        '<h2 id="notes">Notes</h2><p>New para</p><h2 id="notes-1">Notes</h2><p>Alpha para</p><h2 id="notes-2">Notes</h2><p>Beta para</p>',
      )
      const [before, after, start, expectedStart] = reverse
        ? ([second, first, 18, 5] as const)
        : ([first, second, 5, 18] as const)
      const range = mapAnchorRange(
        buildAnchorTransition(before, after)!,
        start,
        start + 10,
      )
      expect(range).toEqual({
        textStart: expectedStart,
        textEnd: expectedStart + 10,
      })
      expect(after.text.slice(expectedStart, expectedStart + 10)).toBe(
        'Alpha para',
      )
    },
  )

  test('punctuation does not rescue a replaced paragraph', () => {
    const before = extractAnchorDocument('<p>abc.</p>'),
      after = extractAnchorDocument('<p>XYZ.</p>')
    expect(mapAnchorRange(buildAnchorTransition(before, after)!, 0, 4)).toEqual(
      { reason: 'replaced-block' },
    )
  })
})

// A deliberately slow per-character oracle checks arbitrary ranges, including
// ranges crossing blocks, edits, duplicate groups and punctuation-only remnants.
test('fixed-seed random old/new/range triples obey survivor and duplicate rules', () => {
  let seed = 0x5eed
  const random = (size: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return Math.floor((seed / 0x1_0000_0000) * size)
  }
  const words = ['A', 'Beta', 'Comment here', 'A', 'X.', 'Y.', ' ', '😀']
  let attached = 0,
    absent = 0,
    untouched = 0,
    edited = 0
  for (let trial = 0; trial < 1000; trial++) {
    const values = Array.from(
      { length: 2 + random(7) },
      () => words[random(words.length)]!,
    )
    const updated = [...values]
    for (let edit = 0; edit <= trial % 4; edit++) {
      const at = random(updated.length + 1)
      switch (random(4)) {
        case 0:
          updated.splice(at, 0, words[random(words.length)]!)
          break
        case 1:
          updated.splice(at, 1)
          break
        case 2:
          updated.splice(at, 1, words[random(words.length)]!)
          break
        case 3:
          updated.reverse()
          break
      }
    }
    const before = paragraphs(values),
      after = paragraphs(updated)
    const map = buildAnchorTransition(before, after)!
    const start = random(before.text.length),
      end = start + 1 + random(before.text.length - start)
    const kept: Array<number | undefined> = Array(before.text.length)
    for (const run of map.matches)
      for (let i = 0; i < run.length; i++) {
        kept[run.oldStart + i] = run.newStart + i
        expect(after.text[run.newStart + i]).toBe(before.text[run.oldStart + i])
      }
    const invalid: Array<{ start: number; end: number }> = []
    for (const block of before.blocks) {
      const value = before.text.slice(block.start, block.end)
      if (!value.trim()) continue
      const copies = before.blocks.filter(
        (item) => before.text.slice(item.start, item.end) === value,
      )
      const targets = after.blocks.filter(
        (item) => after.text.slice(item.start, item.end) === value,
      )
      const pure = copies.every((copy) => {
        const target = kept[copy.start]
        return (
          target !== undefined &&
          targets.some(
            (item) =>
              item.start === target && item.end === target + value.length,
          ) &&
          Array.from(
            { length: value.length },
            (_, i) => kept[copy.start + i] === target + i,
          ).every(Boolean)
        )
      })
      const duplicateChanged =
        Math.max(copies.length, targets.length) >= 2 &&
        (copies.length !== targets.length || !pure)
      const survivors = Array.from(
        { length: block.end - block.start },
        (_, i) =>
          kept[block.start + i] === undefined
            ? ''
            : before.text[block.start + i],
      ).join('')
      const replaced =
        /[^\p{P}\p{Z}\s]/u.test(value) && !/[^\p{P}\p{Z}\s]/u.test(survivors)
      const boundaries = (offset: number) => {
        let left = offset - 1,
          right = offset
        while (left >= 0 && kept[left] === undefined) left--
        while (right < kept.length && kept[right] === undefined) right++
        return [
          left >= 0 ? kept[left]! + 1 : 0,
          right < kept.length ? kept[right]! : after.text.length,
        ]
      }
      const starts = boundaries(block.start),
        ends = boundaries(block.end)
      const sameBlock = after.blocks.some(
        (target) => starts.includes(target.start) && ends.includes(target.end),
      )
      const length = block.end - block.start
      const blockKept = kept.slice(block.start, block.end)
      const intact =
        blockKept[0] !== undefined &&
        blockKept.every((offset, i) => offset === blockKept[0]! + i)
      const adjacentDeletedCopy =
        intact &&
        ((block.start >= length &&
          before.text.slice(block.start - length, block.start) === value &&
          kept
            .slice(block.start - length, block.start)
            .every((offset) => offset === undefined)) ||
          (block.end + length <= before.text.length &&
            before.text.slice(block.end, block.end + length) === value &&
            kept
              .slice(block.end, block.end + length)
              .every((offset) => offset === undefined)))
      if (duplicateChanged || replaced || (!sameBlock && adjacentDeletedCopy))
        invalid.push(block)
    }
    const survivors = kept
      .slice(start, end)
      .filter((offset): offset is number => offset !== undefined)
    const result = mapAnchorRange(map, start, end)
    if (
      invalid.some((block) => block.start < end && block.end > start) ||
      !survivors.length
    ) {
      expect(result).toHaveProperty('reason')
      absent++
    } else {
      const expectedStart = survivors[0]!,
        expectedEnd = survivors.at(-1)! + 1
      expect(result).toEqual({ textStart: expectedStart, textEnd: expectedEnd })
      // Only kept original characters and new text between those survivors
      // belong to the envelope; exterior replacements/insertions stay outside.
      const envelope = survivors.reduce(
        (text, offset, i) =>
          text +
          (i ? after.text.slice(survivors[i - 1]! + 1, offset) : '') +
          after.text[offset],
        '',
      )
      expect(after.text.slice(expectedStart, expectedEnd)).toBe(envelope)
      const pure =
        survivors.length === end - start &&
        survivors.every((offset, i) => offset === expectedStart + i)
      if (pure) {
        expect(after.text.slice(expectedStart, expectedEnd)).toBe(
          before.text.slice(start, end),
        )
        untouched++
      } else edited++
      attached++
    }
  }
  expect(attached).toBeGreaterThan(100)
  expect(absent).toBeGreaterThan(100)
  expect(untouched).toBeGreaterThan(100)
  expect(edited).toBeGreaterThan(10)
})
