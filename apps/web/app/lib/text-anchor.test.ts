import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { TEXT_ANCHOR_ENGINE_SCRIPT } from '../../../../packages/viewer-kit/src/text-anchor'

// Pure resolution tests run without a layout engine. Browser tests exercise
// normalization boundaries, real selections and source ranges.
function engine(text: string, additionalText?: string) {
  const parent = { closest: () => null, localName: 'div' }
  const nodes = [{ parentElement: parent, nodeValue: text }]
  if (additionalText !== undefined)
    nodes.push({
      parentElement: { closest: () => null, localName: 'div' },
      nodeValue: additionalText,
    })
  return measure(nodes, parent)
}

type StubElement = {
  parentElement?: StubElement
  localName: string
  closest: () => null
}
function measure(
  nodes: {
    parentElement: StubElement
    nodeValue?: string
    nodeType?: number
    localName?: string
    closest?: () => null
  }[],
  parent: StubElement,
) {
  const document = {
    createTreeWalker: () => {
      let index = 0
      return { nextNode: () => nodes[index++] ?? null }
    },
  }
  return new Function(
    'document',
    'NodeFilter',
    `${TEXT_ANCHOR_ENGINE_SCRIPT}; return createTextAnchorEngine(arguments[2])`,
  )(document, { SHOW_TEXT: 4 }, parent) as {
    text: string
    hash: string
    paintedText: (
      first: { startContainer: object; startOffset: number },
      last: { endContainer: object; endOffset: number },
    ) => string | null
    normalizedQuote: (selector: {
      quotedText: string
      selectorFormat?: string
    }) => string
    resolve: (selector: object) => { textStart: number; textEnd: number } | null
  }
}

function panelEngine(second = true) {
  function element(
    localName: string,
    parentElement?: StubElement,
  ): StubElement {
    return { localName, parentElement, closest: () => null }
  }
  const root = element('main')
  const gap = element('section', root)
  const plain = element('section', root)
  const nodes = [
    { parentElement: gap, nodeValue: 'before selected ' },
    { parentElement: element('span', gap), nodeValue: 'HIDDEN' },
    { parentElement: gap, nodeValue: 'words after' },
  ]
  if (second)
    nodes.push({
      parentElement: plain,
      nodeValue: 'before selected words after',
    })
  return measure(nodes, root)
}

describe('strict normalized selectors', () => {
  test.each(['br', 'hr'])(
    'void %s nodes separate adjacent text',
    (localName) => {
      const parent = { closest: () => null, localName: 'div' }
      const boundary = {
        parentElement: parent,
        nodeType: 1,
        localName,
        closest: () => null,
      }
      const measured = measure(
        [
          boundary,
          { parentElement: parent, nodeValue: 'a' },
          boundary,
          boundary,
          { parentElement: parent, nodeValue: 'b' },
        ],
        parent,
      )
      expect(measured.text).toBe('a b')
      expect(measured.resolve({ quotedText: 'a b' })).toEqual({
        textStart: 0,
        textEnd: 3,
      })
    },
  )
  test.each(['', 'abc', '😀 日本語 é', 'a'.repeat(64), 'abc'.repeat(1000)])(
    'whole-text hash agrees with SHA-256: %s',
    (text) => {
      const measured = engine(text)
      expect(measured.hash).toBe(
        createHash('sha256').update(measured.text).digest('hex'),
      )
    },
  )
  test('legacy context is exact: it never invents spaces at context boundaries', () => {
    const selector = {
      quotedText: 'selected words',
      prefixText: 'Hello the',
      suffixText: 'here',
      textStart: 999,
      textEnd: 1013,
    }
    expect(engine('Hello the selected words here').resolve(selector)).toBeNull()
    expect(engine('Hello theselected wordshere').resolve(selector)).toEqual({
      textStart: 9,
      textEnd: 23,
    })
    expect(
      engine('Hello the selected words here').resolve({
        ...selector,
        prefixText: 'Hello the ',
        suffixText: ' here',
      }),
    ).toEqual({ textStart: 10, textEnd: 24 })
  })
  test('hidden duplicates contribute to the whole-text hash and selector uniqueness', () => {
    const measured = engine('before quote after', 'before quote after')
    expect(measured.text).toBe('before quote after before quote after')
    expect(measured.hash).not.toBe(engine('before quote after').hash)
    expect(measured.hash).toBe(
      createHash('sha256').update(measured.text).digest('hex'),
    )
    for (const selectorFormat of [undefined, 'quote-v1', 'normalized-v1']) {
      expect(
        measured.resolve({
          selectorFormat,
          quotedText: 'quote',
          prefixText: 'before ',
          suffixText: ' after',
        }),
      ).toBeNull()
    }
  })
  test('a unique context including hidden text resolves without trusted hints', () => {
    const measured = panelEngine(false)
    for (const selectorFormat of [undefined, 'quote-v1', 'normalized-v1']) {
      expect(
        measured.resolve({
          selectorFormat,
          quotedText:
            selectorFormat === 'normalized-v1'
              ? 'selected HIDDENwords'
              : ' selected HIDDENwords\n',
          prefixText: 'before ',
          suffixText: ' after',
        }),
      ).toEqual({ textStart: 7, textEnd: 27 })
    }
    expect(
      measured.resolve({
        quotedText: ' selected HIDDENwords\n',
        prefixText: 'before ',
        suffixText: ' after',
      }),
    ).toEqual({ textStart: 7, textEnd: 27 })
  })

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

test('painted endpoints use the shared index including inserted text and normalized whitespace', () => {
  const parent = { closest: () => null, localName: 'p' }
  const first = { parentElement: parent, nodeValue: 'prefix selected   ' }
  const last = { parentElement: parent, nodeValue: 'words suffix' }
  const start = { startContainer: first, startOffset: 7 }
  const end = { endContainer: last, endOffset: 5 }
  const before = measure([first, last], parent)
  expect(before.paintedText(start, end)).toBe('selected words')
  expect(before.normalizedQuote({ quotedText: ' selected\n words  ' })).toBe(
    'selected words',
  )
  const inserted = { parentElement: parent, nodeValue: 'changed ' }
  const after = measure([first, inserted, last], parent)
  expect(after.paintedText(start, end)).toBe('selected changed words')
  expect(measure([last], parent).paintedText(start, end)).toBeNull()
  expect(after.paintedText(start, { ...end, endOffset: 0 })).toBeNull()
})
