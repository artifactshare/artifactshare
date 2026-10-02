import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { TEXT_ANCHOR_ENGINE_SCRIPT } from '../../../../packages/viewer-kit/src/text-anchor'

// Pure resolution tests run without a layout engine. Browser tests exercise
// visibility, normalization boundaries, real selections and source ranges.
function engine(text: string) {
  const parent = { closest: () => null, checkVisibility: () => true }
  let consumed = false
  const document = {
    createTreeWalker: () => ({
      nextNode: () =>
        consumed
          ? null
          : ((consumed = true), { parentElement: parent, nodeValue: text }),
    }),
  }
  return new Function(
    'document',
    'NodeFilter',
    'getComputedStyle',
    `${TEXT_ANCHOR_ENGINE_SCRIPT}; return createTextAnchorEngine(arguments[3])`,
  )(document, { SHOW_TEXT: 4 }, () => ({ display: 'block' }), parent) as {
    text: string
    hash: string
    resolve: (selector: object) => { textStart: number; textEnd: number } | null
  }
}

describe('strict normalized selectors', () => {
  test.each(['', 'abc', '😀 日本語 é', 'a'.repeat(64), 'abc'.repeat(1000)])(
    'whole-text hash agrees with SHA-256: %s',
    (text) => {
      const measured = engine(text)
      expect(measured.hash).toBe(
        createHash('sha256').update(measured.text).digest('hex'),
      )
    },
  )
  test('does not pick the nearest repeated quote', () => {
    const before = engine('Hello world world')
    const selector = {
      selectorFormat: 'normalized-v1',
      quotedText: 'world',
      prefixText: 'Hello world ',
      suffixText: '',
      textStart: 12,
      textEnd: 17,
      textHash: before.hash,
      ambiguousAtCreation: false,
    }
    expect(engine('Look! Hello world world').resolve(selector)).toEqual({
      textStart: 18,
      textEnd: 23,
    })
    expect(engine('Look! Hello world').resolve(selector)).toBeNull()
  })
  test('hash permits an ambiguous creation only when both quote and adjacent context still match', () => {
    const before = engine('target '.repeat(100))
    const selector = {
      selectorFormat: 'normalized-v1',
      quotedText: 'target',
      prefixText: 'target ',
      suffixText: ' target',
      textStart: 350,
      textEnd: 356,
      textHash: before.hash,
      ambiguousAtCreation: true,
    }
    expect(before.resolve(selector)).toEqual({ textStart: 350, textEnd: 356 })
    expect(engine('target '.repeat(101)).resolve(selector)).toBeNull()
    expect(
      before.resolve({ ...selector, textStart: 351, textEnd: 357 }),
    ).toBeNull()
  })
  test('legacy and quote-only selectors never trust hints, including after a write-back', () => {
    const measured = engine('aaaaa')
    for (const selectorFormat of [undefined, 'quote-v1']) {
      expect(
        measured.resolve({
          selectorFormat,
          quotedText: 'aa',
          prefixText: 'a',
          suffixText: 'a',
          textStart: 1,
          textEnd: 3,
          textHash: measured.hash,
        }),
      ).toBeNull()
      expect(
        measured.resolve({
          selectorFormat,
          quotedText: 'aaa',
          prefixText: 'a',
          suffixText: 'a',
          textStart: 999,
          textEnd: 1002,
          textHash: measured.hash,
        }),
      ).toEqual({ textStart: 1, textEnd: 4 })
    }
  })
  test('unrelated edits preserve exact hints but changed context is never scored', () => {
    const text = 'prefix quote suffix distant'
    const selector = {
      selectorFormat: 'normalized-v1',
      quotedText: 'quote',
      prefixText: 'prefix ',
      suffixText: ' suffix',
      textStart: 7,
      textEnd: 12,
      textHash: engine(text).hash,
    }
    expect(engine(text + ' edit').resolve(selector)).toEqual({
      textStart: 7,
      textEnd: 12,
    })
    expect(engine('prefix changed suffix quote').resolve(selector)).toBeNull()
    expect(engine('prefix quote altered').resolve(selector)).toBeNull()
    expect(
      engine('prefix quote suffix prefix quote suffix').resolve(selector),
    ).toBeNull()
  })
  test('empty quote never attaches and legacy context whitespace is normalized without trimming edges', () => {
    expect(
      engine('word').resolve({
        quotedText: '',
        prefixText: '',
        suffixText: '',
      }),
    ).toBeNull()
    expect(
      engine('before word after').resolve({
        quotedText: 'word',
        prefixText: 'before\n ',
        suffixText: '\u00a0after',
      }),
    ).toEqual({ textStart: 7, textEnd: 11 })
  })
})
