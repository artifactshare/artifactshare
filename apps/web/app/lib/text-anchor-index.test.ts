// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { createTextAnchorEngine as build } from '@artifactshare/viewer-kit/reporter/anchor-engine'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function fixture() {
  const root = document.createElement('main')
  root.innerHTML =
    '<p>' +
    'padding '.repeat(1000) +
    '</p><p id="target">  before <b>selected</b>   words <i data-anchor-ignore>ignored</i> after</p>'
  document.body.appendChild(root)
  return { root, engine: build(root) }
}

test('text endpoints map through the existing node index without constructing per-character ranges', () => {
  const { root, engine } = fixture()
  const range = document.createRange()
  range.setStart(root.querySelector('b')!.firstChild!, 0)
  range.setEnd(root.querySelector('b')!.nextSibling!, 8)
  const createRange = vi.spyOn(document, 'createRange')
  const selector = engine.describe(range)!
  expect(selector.quotedText).toBe('selected words')
  expect(engine.text.slice(selector.textStart, selector.textEnd)).toBe(
    selector.quotedText,
  )
  expect(createRange).not.toHaveBeenCalled()
})

test('element endpoints use logarithmic lookup across a long document', () => {
  const { root, engine } = fixture()
  const target = root.querySelector('#target')!
  const range = document.createRange()
  range.setStart(target, 1)
  range.setEnd(target, 3)
  const createRange = vi.spyOn(document, 'createRange')
  const compare = vi.spyOn(Range.prototype, 'comparePoint')
  expect(engine.describe(range)!.quotedText).toBe('selected words')
  expect(createRange.mock.calls.length).toBeLessThanOrEqual(2)
  expect(compare.mock.calls.length).toBeLessThanOrEqual(30)
})

test('endpoints inside ignored text map only the remaining eligible characters', () => {
  const { root, engine } = fixture()
  const range = document.createRange()
  range.setStart(root.querySelector('i')!.firstChild!, 2)
  range.setEnd(root.querySelector('#target')!.lastChild!, 6)
  expect(engine.describe(range)!.quotedText).toBe('after')
  range.setEnd(root.querySelector('i')!.firstChild!, 4)
  expect(engine.describe(range)).toBeNull()
})

function locusFixture(
  html: string,
  selector = '#target',
  start = 0,
  end?: number,
) {
  document.body.innerHTML = html
  const root = document.body
  const target = root.querySelector(selector)!.firstChild!
  const range = document.createRange()
  range.setStart(target, start)
  range.setEnd(target, end ?? target.textContent!.length)
  const engine = build(root)
  return { engine, range, locus: engine.locus(range) }
}

test('creation locus follows heading ranks and ignores excluded headings', () => {
  const { locus } = locusFixture(`<h1> Teams </h1><section><h2>Hiring</h2>
    <ul><li>Alice Bob</li></ul><h3>Details</h3></section>
    <section><h2> Training </h2><aside data-anchor-ignore><h1>Ignore</h1></aside>
    <ul><li id="target">Alice Bob</li></ul></section>`)
  expect(locus).toEqual({
    headings: ['Teams', 'Training'],
    block_text: 'Alice Bob',
  })
  expect(
    locusFixture('<h1>A</h1><h4>B</h4><h3>C</h3><p id="target">word</p>').locus
      ?.headings,
  ).toEqual(['A', 'C'])
  expect(
    locusFixture('<span id="target">word</span><h1>Later</h1>').locus,
  ).toEqual({ headings: [], block_text: 'word Later' })
  expect(
    locusFixture(`<h1>  A \n B ${'x'.repeat(140)}</h1><p id="target">word</p>`)
      .locus?.headings,
  ).toEqual([('A B ' + 'x'.repeat(140)).slice(0, 120)])
})

test('locus uses normalized smallest block text including inline descendants', () => {
  const { locus } = locusFixture(
    '<div>outside<p>before <b id="target">selected</b>   after</p>outside</div>',
  )
  expect(locus).toEqual({ headings: [], block_text: 'before selected after' })
})

test('locus centers a bounded window on the selected later duplicate and clamps edges', () => {
  const block =
    'a'.repeat(100) + 'quote' + 'b'.repeat(1095) + 'quote' + 'c'.repeat(595)
  for (const [start, end, expectedStart] of [
    [1200, 1205, 902],
    [100, 105, 0],
    [1790, 1800, 1200],
    [800, 1500, 850],
  ]) {
    const { locus } = locusFixture(
      `<p id="target">${block}</p>`,
      '#target',
      start,
      end,
    )
    expect(locus?.block_text).toBe(
      block.slice(expectedStart, expectedStart + 600),
    )
  }
})

test('many headings read only final path labels and use bounded node index traversal', () => {
  document.body.innerHTML =
    '<h2>section</h2><p>padding</p>'.repeat(2000) +
    '<p id="target">selected</p>'
  const engine = build(document.body)
  const range = document.createRange()
  range.selectNodeContents(document.querySelector('#target')!)
  const get = vi.spyOn(WeakMap.prototype, 'get')
  expect(engine.locus(range)).toEqual({
    headings: ['section'],
    block_text: 'selected',
  })
  expect(get.mock.calls.length).toBeLessThan(10)
})

test('headings inside a selection do not replace the path at its start', () => {
  document.body.innerHTML =
    '<h1>Teams</h1><p id="start">first</p><h2>Later</h2><p id="end">last</p>'
  const range = document.createRange()
  range.setStart(document.querySelector('#start')!.firstChild!, 0)
  range.setEnd(document.querySelector('#end')!.firstChild!, 4)
  expect(build(document.body).locus(range)?.headings).toEqual(['Teams'])
})
