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
      [select('#hid', 8, '#hid', 8), 'start visible'],
      [select('#l1', 5, '#l2', 4), 'item one List'],
    ] as const
    for (const [range, quote] of cases) {
      const selector = engine.describe(range)!
      expect(selector.quotedText).toBe(quote)
      expect(engine.text.slice(selector.textStart, selector.textEnd)).toBe(
        quote,
      )
      const ranges = engine.ranges(selector.textStart, selector.textEnd)
      expect(
        ranges.every(
          (r) =>
            !r.startContainer.parentElement?.closest('[style="display:none"]'),
        ),
      ).toBe(true)
      expect(
        ranges
          .flatMap((r) => Array.from(r.getClientRects()))
          .some((r) => r.width > 0),
      ).toBe(true)
    }
  })

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
