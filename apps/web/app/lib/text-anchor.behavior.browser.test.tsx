import { afterEach, describe, expect, test } from 'vitest'
import { TEXT_ANCHOR_ENGINE_SCRIPT } from '../../../../packages/viewer-kit/src/text-anchor'

type Selector = {
  quotedText: string
  prefixText: string
  suffixText: string
  textStart: number
  textEnd: number
  textHash: string
  selectorFormat: string
  ambiguousAtCreation: boolean
}
type Engine = {
  text: string
  hash: string
  describe: (range: Range) => Selector | null
  resolve: (
    selector: Partial<Selector>,
  ) => { textStart: number; textEnd: number } | null
  ranges: (start: number, end: number) => Range[]
}
const build = new Function(
  'root',
  `${TEXT_ANCHOR_ENGINE_SCRIPT}; return createTextAnchorEngine(root)`,
) as (root: HTMLElement) => Engine
let root: HTMLDivElement
function fixture(html: string) {
  root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return build(root)
}
function select(
  start: string,
  startOffset: number,
  end = start,
  endOffset?: number,
) {
  const range = document.createRange()
  const first = root.querySelector(start)!.firstChild!
  const last = root.querySelector(end)!.lastChild!
  range.setStart(first, startOffset)
  range.setEnd(last, endOffset ?? last.textContent!.length)
  return range
}
afterEach(() => root?.remove())

describe('the injected normalized anchor engine', () => {
  test('describes collapsed whitespace, raw casing, hidden gaps and block boundaries', () => {
    const engine = fixture(
      `<p id="ws">Spaced     text   with\n   line breaks inside it.</p><p id="tt" style="text-transform:uppercase">lowercase words shown upper</p><p id="hid">Visible start <span style="display:none">HIDDEN</span> visible end.</p><ul><li id="l1">List item one</li><li id="l2">List item two</li></ul>`,
    )
    const cases = [
      [
        select(
          '#ws',
          0,
          '#ws',
          root.querySelector('#ws')!.textContent!.indexOf('breaks') + 6,
        ),
        'Spaced text with line breaks',
      ],
      [select('#tt', 0, '#tt', 15), 'lowercase words'],
      [select('#hid', 8, '#hid', 8), 'start HIDDEN visible'],
      [select('#l1', 5, '#l2', 4), 'item one List'],
    ] as const
    const selectors: Selector[] = []
    for (const [range, quote] of cases) {
      const selector = engine.describe(range)!
      expect(selector.quotedText).toBe(quote)
      const context = selector.prefixText + quote + selector.suffixText
      const at = engine.text.indexOf(context)
      expect(at, quote).toBeGreaterThanOrEqual(0)
      expect(engine.text.indexOf(context, at + 1), quote).toBe(-1)
      expect(selector.ambiguousAtCreation, quote).toBe(false)
      selectors.push(selector)
      // Selection and resolution use the same eligible source characters.
      expect(engine.resolve(selector), quote).toEqual({
        textStart: selector.textStart,
        textEnd: selector.textEnd,
      })
      expect(engine.text.slice(selector.textStart, selector.textEnd)).toBe(
        quote,
      )
      const ranges = engine.ranges(selector.textStart, selector.textEnd)
      if (quote === 'start HIDDEN visible') {
        const hidden = ranges.find(
          (r) =>
            r.startContainer === root.querySelector('#hid span')!.firstChild,
        )!
        expect(hidden.startOffset).toBe(0)
        expect(hidden.endOffset).toBe(6)
        expect(
          Array.from(hidden.getClientRects()).some((rect) => rect.width > 0),
        ).toBe(false)
      }
      expect(
        ranges
          .flatMap((r) => Array.from(r.getClientRects()))
          .some((r) => r.width > 0),
      ).toBe(true)
    }
    root.insertAdjacentHTML('beforeend', '<p>unrelated edit</p>')
    const changed = build(root)
    expect(changed.hash).not.toBe(engine.hash)
    for (const selector of selectors) {
      const expected = {
        textStart: selector.textStart,
        textEnd: selector.textEnd,
      }
      expect(changed.resolve(selector), selector.quotedText).toEqual(expected)
      for (const selectorFormat of [undefined, 'quote-v1']) {
        expect(
          changed.resolve({ ...selector, selectorFormat }),
          selector.quotedText,
        ).toEqual(expected)
      }
    }
  })

  test.each(['br', 'hr'])(
    'normalizes void %s boundaries without painting separators',
    (tag) => {
      const engine = fixture(`<span>a</span><${tag}><span>b</span>`)
      expect(engine.text).toBe('a b')
      const range = document.createRange()
      range.selectNodeContents(root)
      const selector = engine.describe(range)!
      expect(selector.quotedText).toBe('a b')
      expect(engine.resolve(selector)).toEqual({ textStart: 0, textEnd: 3 })
      const ranges = engine.ranges(0, 3)
      expect(ranges.map((piece) => piece.toString())).toEqual(['a', 'b'])
      expect(ranges[0].startContainer).toBe(root.firstChild!.firstChild)
      expect(ranges[1].endContainer).toBe(root.lastChild!.firstChild)
      root.innerHTML = `<${tag}>a <${tag}><${tag}> b`
      expect(build(root).text).toBe('a b')
    },
  )

  test.each([
    { source: 'parsed HTML', text: ' code', start: 1, end: 5 },
    { source: 'DOM text', text: '\n code', start: 2, end: 6 },
  ])(
    'NBSP, display:contents, nested blocks, ignored toolbar and pre leading newline ($source)',
    ({ source, text, start, end }) => {
      fixture(
        '<div><span>A&nbsp;</span><span style="display:contents">&nbsp;B</span><div>C</div>D</div><figure><figcaption data-anchor-ignore>Copy code</figcaption><pre id="code">\n code</pre></figure>',
      )
      const code = root.querySelector('#code')!
      // HTML parsing consumes the first newline after <pre>; DOM insertion retains it.
      if (source === 'DOM text') code.textContent = '\n code'
      expect(code.textContent).toBe(text)
      const engine = build(root)
      expect(engine.text).toBe('A B C D code')
      const range = document.createRange()
      range.selectNodeContents(code)
      const selector = engine.describe(range)!
      expect(selector.quotedText).toBe('code')
      expect(engine.text.slice(selector.textStart, selector.textEnd)).toBe(
        'code',
      )
      expect(engine.resolve(selector)).toEqual({
        textStart: selector.textStart,
        textEnd: selector.textEnd,
      })
      const paints = engine.ranges(selector.textStart, selector.textEnd)
      expect(paints).toHaveLength(1)
      const [paint] = paints
      expect(paint.startContainer).toBe(code.firstChild)
      expect(paint.endContainer).toBe(code.firstChild)
      expect(paint.startOffset).toBe(start)
      expect(paint.endOffset).toBe(end)
      expect(
        Array.from(paint.getClientRects()).some((rect) => rect.width > 0),
      ).toBe(true)
    },
  )

  test('p4 stays on p4 after insertion at p3, without proximity scoring', () => {
    const engine = fixture('<p id="p3">Hello world</p><p id="p4">world</p>')
    const selector = engine.describe(select('#p4', 0))!
    root.querySelector('#p3')!.prepend('Look! ')
    const updated = build(root)
    expect(updated.resolve(selector)).toEqual({ textStart: 18, textEnd: 23 })
    expect(updated.ranges(18, 23)[0].startContainer.parentElement?.id).toBe(
      'p4',
    )
  })

  test('ambiguous creation uses hash only on unchanged text', () => {
    const engine = fixture(
      Array.from(
        { length: 100 },
        (_, i) => `<p id="line${i}">identical line</p>`,
      ).join(''),
    )
    const selector = engine.describe(select('#line50', 0))!
    expect(selector.ambiguousAtCreation).toBe(true)
    expect(selector.prefixText).toHaveLength(400)
    expect(selector.suffixText).toHaveLength(400)
    expect(engine.resolve(selector)).toEqual({
      textStart: selector.textStart,
      textEnd: selector.textEnd,
    })
    root.insertAdjacentHTML('afterbegin', '<p>identical line</p>')
    expect(build(root).resolve(selector)).toBeNull()
  })

  test('strict complete-context matching counts overlapping hits and ignores legacy hints', () => {
    const engine = fixture('<p>aaaaa</p>')
    expect(
      engine.resolve({
        quotedText: 'aa',
        prefixText: 'a',
        suffixText: 'a',
        textStart: 1,
        textEnd: 3,
        textHash: engine.hash,
      }),
    ).toBeNull()
    expect(
      engine.resolve({ quotedText: '', prefixText: '', suffixText: '' }),
    ).toBeNull()
    expect(
      engine.resolve({
        quotedText: 'aaa',
        prefixText: 'a',
        suffixText: 'a',
        textStart: 999,
        textEnd: 1002,
      }),
    ).toEqual({ textStart: 1, textEnd: 4 })
  })

  test('context destruction never falls back to a quote elsewhere', () => {
    const engine = fixture(
      '<p id="target">before target after</p><p>different target elsewhere</p>',
    )
    const selector = engine.describe(select('#target', 7, '#target', 13))!
    root.querySelector('#target')!.remove()
    expect(build(root).resolve(selector)).toBeNull()
  })

  test('element endpoints, UTF-16 offsets and SHA-256 agree with Web Crypto', async () => {
    const engine = fixture('<p id="unicode">😀猫 é</p><p>tail</p>')
    const range = document.createRange()
    range.setStart(root, 0)
    range.setEnd(root, 1)
    const selector = engine.describe(range)!
    expect(selector.quotedText).toBe('😀猫 é')
    expect(selector.textEnd).toBe(6)
    const bytes = new Uint8Array(
      await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(engine.text),
      ),
    )
    expect(engine.hash).toBe(
      Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
    )
    expect(
      build(root).resolve({ ...selector, textStart: 999, textEnd: 1005 }),
    ).toEqual({ textStart: 0, textEnd: 6 })
  })
})

test('legacy context preserves boundary spaces and rejects hidden duplicates', () => {
  const selector = {
    quotedText: 'selected words',
    prefixText: 'Hello the ',
    suffixText: ' here',
  }
  const engine = fixture('<p>Hello the</p><p>selected words</p><p>here</p>')
  expect(engine.resolve(selector)).toEqual({ textStart: 10, textEnd: 24 })
  root.insertAdjacentHTML(
    'beforeend',
    '<section hidden><p>Hello the</p><p>selected words</p><p>here</p></section>',
  )
  const updated = build(root)
  expect(updated.hash).not.toBe(engine.hash)
  expect(updated.resolve(selector)).toBeNull()
  root.querySelector<HTMLElement>('section')!.hidden = false
  expect(build(root).resolve(selector)).toBeNull()
})

test('hidden source positions do not change the hash of identical normalized text', async () => {
  const engine = fixture(
    '<section id="a"><p id="words">The identical sentence.</p></section><section id="b" hidden><p>The identical sentence.</p></section>',
  )
  expect(engine.text).toBe('The identical sentence. The identical sentence.')
  root.querySelector<HTMLElement>('#a')!.hidden = true
  root.querySelector<HTMLElement>('#b')!.hidden = false
  const changed = build(root)
  expect(changed.text).toBe(engine.text)
  expect(changed.hash).toBe(engine.hash)
  const bytes = new Uint8Array(
    await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(changed.text),
    ),
  )
  expect(changed.hash).toBe(
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''),
  )
})

test('hidden and closed-details text participates in the normalized text', () => {
  const engine = fixture(
    '<p id="words">Visible words</p><p hidden>Invisible</p><p style="visibility:hidden">Hidden</p><details><summary data-anchor-ignore>Toggle</summary><p>Closed</p></details>',
  )
  expect(engine.text).toBe('Visible words Invisible Hidden Closed')
  expect(engine.describe(select('#words', 0))!.quotedText).toBe('Visible words')
})

test('off-screen content-visibility auto participates in the normalized text', async () => {
  fixture(
    '<p>Top</p><div style="height:10000px"></div><section style="content-visibility:auto;contain-intrinsic-size:100px"><p id="offscreen">Offscreen words</p></section>',
  )
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  )
  const engine = build(root)
  expect(engine.text).toBe('Top Offscreen words')
  expect(engine.describe(select('#offscreen', 0))!.quotedText).toBe(
    'Offscreen words',
  )
})

test.each([
  ['hidden attribute', '<span hidden>HIDDEN </span>'],
  ['display:none', '<span style="display:none">HIDDEN </span>'],
  ['visibility:hidden', '<span style="visibility:hidden">HIDDEN </span>'],
  [
    'closed details',
    '<details><summary data-anchor-ignore>Toggle</summary><p>HIDDEN </p></details>',
  ],
])(
  'context crossing %s stays attached after unrelated edits and shifted offsets',
  (_label, hidden) => {
    const engine = fixture(
      `<div id="target">before selected ${hidden}words after</div><p>${'padding '.repeat(100)}</p><p id="far">end</p>`,
    )
    const selector = engine.describe(select('#target', 7, '#target', 5))!
    expect(selector.quotedText).toBe('selected HIDDEN words')
    expect(selector.ambiguousAtCreation).toBe(false)
    expect(engine.resolve(selector)).toEqual({
      textStart: selector.textStart,
      textEnd: selector.textEnd,
    })
    root.querySelector('#far')!.textContent = 'unrelated edit'
    const changed = build(root)
    expect(changed.hash).not.toBe(engine.hash)
    expect(changed.resolve(selector)).toEqual({
      textStart: selector.textStart,
      textEnd: selector.textEnd,
    })
    root.insertAdjacentHTML('afterbegin', '<p>intro</p>')
    const shifted = build(root)
    expect(shifted.resolve(selector)).toEqual({
      textStart: selector.textStart + 6,
      textEnd: selector.textEnd + 6,
    })
    expect(
      shifted.resolve({
        quotedText: ' selected HIDDEN words\n',
        prefixText: 'before ',
        suffixText: ' after',
      }),
    ).toEqual({
      textStart: selector.textStart + 6,
      textEnd: selector.textEnd + 6,
    })
  },
)

test('block separators are determined by tags regardless of display', () => {
  const engine = fixture(
    '<div id="block" style="display:inline">A</div><span>B</span><span id="inline" style="display:none">C</span>D',
  )
  expect(engine.text).toBe('A BCD')
  root.querySelector<HTMLElement>('#block')!.style.display = 'none'
  root.querySelector<HTMLElement>('#inline')!.style.display = 'block'
  const changed = build(root)
  expect(changed.text).toBe(engine.text)
  expect(changed.hash).toBe(engine.hash)
})
