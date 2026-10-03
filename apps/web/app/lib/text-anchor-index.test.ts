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
