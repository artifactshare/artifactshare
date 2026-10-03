// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import { createReporterState } from '../../../../packages/viewer-kit/src/reporter/state.js'
import { createTextAnchorEngine } from '../../../../packages/viewer-kit/src/reporter/anchor-engine.js'
import {
  applyHighlights,
  scrollToThread,
} from '../../../../packages/viewer-kit/src/reporter/highlights.js'
import * as svg from '../../../../packages/viewer-kit/src/reporter/svg-overlay.js'

afterEach(() => {
  vi.restoreAllMocks()
  document
    .querySelectorAll('body > *, html > div, #ash-comment-highlight-style')
    .forEach((node) => node.remove())
})

function rect(left: number, top: number, width: number, height: number) {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

test.each([
  [5000, 0],
  [0, 3000],
  [5000, 3000],
])(
  'reveals the verified text rect at (%i, %i) through nested scrollports and the viewport',
  (quoteX, quoteY) => {
    let viewportY = 0
    const ctx = createReporterState(window)
    const root = document.documentElement
    Object.defineProperties(root, {
      clientWidth: { value: 800, configurable: true },
      clientHeight: { value: 600, configurable: true },
    })
    vi.spyOn(window, 'scrollBy').mockImplementation((options) => {
      viewportY += (options as ScrollToOptions).top || 0
    })
    const outerGeometry = {
      scrollWidth: 3000,
      scrollHeight: 4000,
      clientWidth: 300,
      clientHeight: 250,
      offsetWidth: 300,
      offsetHeight: 250,
      clientLeft: 0,
      clientTop: 0,
      scrollLeft: 0,
      scrollTop: 0,
      getBoundingClientRect: () => rect(0, 900 - viewportY, 300, 250),
      scrollBy({ left, top }: { left: number; top: number }) {
        this.scrollLeft = Math.min(2700, Math.max(0, this.scrollLeft + left))
        this.scrollTop = Math.min(3750, Math.max(0, this.scrollTop + top))
      },
    }
    const outer = document.createElement('div')
    for (const [key, value] of Object.entries(outerGeometry))
      Object.defineProperty(outer, key, {
        value,
        writable: true,
        configurable: true,
      })
    root.appendChild(outer)
    const innerGeometry = {
      scrollWidth: 6000,
      scrollHeight: 4000,
      clientWidth: 200,
      clientHeight: 140,
      offsetWidth: 200,
      offsetHeight: 140,
      clientLeft: 0,
      clientTop: 0,
      scrollLeft: 0,
      scrollTop: 0,
      getBoundingClientRect: () =>
        rect(
          2400 - outer.scrollLeft,
          2900 - viewportY - outer.scrollTop,
          200,
          140,
        ),
      scrollBy({ left, top }: { left: number; top: number }) {
        this.scrollLeft = Math.min(5800, Math.max(0, this.scrollLeft + left))
        this.scrollTop = Math.min(3860, Math.max(0, this.scrollTop + top))
      },
    }
    const inner = document.createElement('div')
    for (const [key, value] of Object.entries(innerGeometry))
      Object.defineProperty(inner, key, {
        value,
        writable: true,
        configurable: true,
      })
    outer.appendChild(inner)
    const target = document.createElement('p')
    inner.appendChild(target)
    target.textContent = 'quote'
    vi.spyOn(target, 'scrollIntoView').mockImplementation(() => {})
    const range = document.createRange()
    range.selectNodeContents(target)
    vi.spyOn(range, 'getClientRects').mockImplementation(() => {
      const box = inner.getBoundingClientRect()
      return [
        rect(
          box.left + quoteX - inner.scrollLeft,
          box.top + quoteY - inner.scrollTop,
          100,
          20,
        ),
      ] as unknown as DOMRectList
    })
    const reposition = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockReturnValue(1)
    ctx.paintedAnchors.push({
      highlight: { threadId: 'verified', quotedText: 'quote' },
      ranges: [range],
      groups: [],
    })
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element) =>
        ({
          overflowX: element === target ? 'visible' : 'auto',
          overflowY: element === target ? 'visible' : 'auto',
        }) as CSSStyleDeclaration,
    )
    scrollToThread(ctx, 'verified')
    const quote = range.getClientRects()[0]!
    for (const viewport of [
      inner.getBoundingClientRect(),
      outer.getBoundingClientRect(),
      rect(0, 0, 800, 600),
    ]) {
      expect(quote.left).toBeGreaterThanOrEqual(viewport.left)
      expect(quote.right).toBeLessThanOrEqual(viewport.right)
      expect(quote.top).toBeGreaterThanOrEqual(viewport.top)
      expect(quote.bottom).toBeLessThanOrEqual(viewport.bottom)
    }
    expect(reposition).toHaveBeenCalledOnce()
  },
)

test('covered resolved text is retained for jump without invoking painting', () => {
  document.body.innerHTML = '<main data-comment-content>quote</main>'
  const ctx = createReporterState(window)
  ctx.checkingDeadlines = { open: 1, resolved: 1 }
  const engine = createTextAnchorEngine(document.querySelector('main')!)
  const ranges = engine.ranges(0, 5)
  const resolveRanges = vi.spyOn(engine, 'ranges').mockReturnValue(ranges)
  const paint = vi.spyOn(svg, 'wrapSvgRange')
  const send = vi.fn()
  ctx.primordials.savedPostMessage = send
  applyHighlights(
    ctx,
    [
      { threadId: 'open', status: 'open', quotedText: 'quote' },
      { threadId: 'resolved', status: 'resolved', quotedText: 'quote' },
    ],
    engine,
  )
  expect(ctx.checkingDeadlines).toEqual({})
  expect(paint).toHaveBeenCalledTimes(1)
  expect(ctx.paintedAnchors.map((entry) => entry.highlight.threadId)).toEqual([
    'open',
    'resolved',
  ])
  expect(resolveRanges).toHaveBeenCalledTimes(2)
  expect(resolveRanges).toHaveBeenNthCalledWith(1, 0, 5)
  expect(resolveRanges).toHaveBeenNthCalledWith(2, 0, 5)
  expect(ctx.paintedAnchors[0]!.ranges).toBe(ranges)
  expect(ctx.paintedAnchors[1]!.ranges).toBe(ranges)
  expect(send.mock.calls[0]![1].results[1].state).toBe('attached')
})
