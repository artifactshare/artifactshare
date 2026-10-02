import { expect, test, vi } from 'vitest'
import { VIOLATION_REPORTER_SCRIPT_BODY } from './csp-reporter'

// Execute the actual injected jump handler with deterministic layout geometry.
// Browser tests cover real Range rects for plain-text code and tall blocks.
const start = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
  '  function scrollToThread(id) {',
)
const end = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
  '  function hitComment(event) {',
  start,
)
const jump = new Function(
  'paintedAnchors',
  'document',
  'window',
  'getComputedStyle',
  'schedulePositionBadges',
  `${VIOLATION_REPORTER_SCRIPT_BODY.slice(start, end)}; return scrollToThread`,
)

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
    const root = { clientWidth: 800, clientHeight: 600 }
    const window = {
      scrollBy: ({ top }: { top: number }) => {
        viewportY += top
      },
    }
    const outer = {
      parentElement: root,
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
    const inner = {
      parentElement: outer,
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
    const target = { parentElement: inner, scrollIntoView: vi.fn() }
    const range = {
      startContainer: { nodeType: 3, parentElement: target },
      getClientRects: () => {
        const box = inner.getBoundingClientRect()
        return [
          rect(
            box.left + quoteX - inner.scrollLeft,
            box.top + quoteY - inner.scrollTop,
            100,
            20,
          ),
        ]
      },
    }
    const reposition = vi.fn()
    jump(
      [{ highlight: { threadId: 'verified' }, ranges: [range] }],
      { scrollingElement: root, documentElement: root },
      window,
      (element: unknown) => ({
        overflowX: element === target ? 'visible' : 'auto',
        overflowY: element === target ? 'visible' : 'auto',
      }),
      reposition,
    )('verified')
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
  const wrapStart = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function wrapRange(',
  )
  const wrapEnd = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function missingState(',
    wrapStart,
  )
  const applyStart = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function applyHighlights(',
  )
  const applyEnd = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function invalidateChangedPaint(',
    applyStart,
  )
  const paint = vi.fn(() => true)
  const send = vi.fn()
  const ranges = [{ startContainer: { parentElement: {} } }]
  const run = new Function(
    'engine',
    'wrapSvgRange',
    'send',
    `
    var paintedAnchors = [], pendingHighlights = [], measuredText;
    var highlightNames = [], documentToken = '', displayedVersionId = 'v1', displayedPath = null;
    var lastResolutionSignature = '', resolutionGeneration = 0;
    var checkingDeadlines = { open: 1, resolved: 1 }, reusableBadges = new Map();
    function clearMarks() { paintedAnchors = []; }
    function ensureCommentStyles() {}
    function highlightPalette() {}
    function isDarkBackground() {}
    function positionBadges() {}
    function scheduleChecking() {}
    ${VIOLATION_REPORTER_SCRIPT_BODY.slice(wrapStart, wrapEnd)}
    ${VIOLATION_REPORTER_SCRIPT_BODY.slice(applyStart, applyEnd)}
    applyHighlights([
      { threadId: 'open', status: 'open' },
      { threadId: 'resolved', status: 'resolved' }
    ], engine);
    return { paintedAnchors, checkingDeadlines };
  `,
  )
  const result = run(
    {
      text: 'quote',
      hash: 'hash',
      resolve: () => ({ textStart: 0, textEnd: 5 }),
      ranges: () => ranges,
    },
    paint,
    send,
  )
  const retained = result.paintedAnchors
  expect(result.checkingDeadlines).toEqual({})
  expect(paint).toHaveBeenCalledTimes(1)
  expect(
    retained.map(
      (entry: { highlight: { threadId: string } }) => entry.highlight.threadId,
    ),
  ).toEqual(['open', 'resolved'])
  expect(retained[1].ranges).toBe(ranges)
  expect(send.mock.calls[0]![0].results[1].state).toBe('attached')
})
