import { afterEach, expect, test, vi } from 'vitest'
import {
  VIOLATION_REPORTER_SCRIPT_BODY,
  type AnchorResolutionMessage,
} from './csp-reporter'

// Run the injected application and observer together with deterministic snapshots.
// The browser suite supplies real DOM ranges, exclusions, badges and palettes.
function fixture() {
  const start = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function applyHighlights(',
  )
  const end = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function scrollToThread(',
    start,
  )
  const source = {
    text: 'quote',
    excluded: false,
    paintedText: 'quote',
    dark: false,
  }
  const element = { closest: () => null }
  const range = { startContainer: { parentElement: element } }
  const build = vi.fn(() => {
    const { text, excluded } = source
    return {
      text,
      hash: text,
      resolve: () => (excluded ? null : { textStart: 0, textEnd: 5 }),
      ranges: () => [range],
      paintedText: () => source.paintedText,
      normalizedQuote: () => 'quote',
    }
  })
  const paint = vi.fn()
  const send = vi.fn<(message: AnchorResolutionMessage) => void>()
  const root = { contains: () => true }
  const run = new Function(
    'createTextAnchorEngine',
    'paint',
    'send',
    'source',
    'root',
    'setTimeout',
    'clearTimeout',
    `
    var pendingHighlights = [], pendingAnchors = [], measuredText = null;
    var anchorSnapshotGeneration = 0, appliedHighlightKey = '';
    var paintedAnchors = [], textPaints = [], badges = [], reusableBadges = new Map();
    var resolveStartedAt = 0, resolveTimer, checkingTimer, badgePositionFrame;
    var lastResolutionSignature = '', resolutionGeneration = 0, checkingDeadlines = {};
    var documentToken = 'token', displayedVersionId = 'v1', displayedPath = '/';
    var document = { body: {}, documentElement: {}, querySelectorAll: () => [] };
    var window = { addEventListener: () => {} };
    var observer;
    function MutationObserver(callback) { observer = callback; this.observe = () => {}; }
    function anchorRoot() { return root; }
    function clearMarks() { paintedAnchors = []; appliedHighlightKey = ''; }
    function wrapRange(highlight, engine) {
      paintedAnchors.push({ highlight, ranges: engine.ranges() });
      paint(highlight);
    }
    function isDarkBackground() { return source.dark; }
    function positionBadges() {}
    function schedulePositionBadges() {}
    function scheduleChecking() {}
    function verifyAnchors() {}
    function missingState() { return 'checking'; }
    ${VIOLATION_REPORTER_SCRIPT_BODY.slice(start, end)}
    return {
      apply: () => applyHighlights([{ threadId: 'quote', quotedText: 'quote' }]),
      mutate: (attribute) => observer([{
        type: attribute ? 'attributes' : 'characterData',
        attributeName: attribute,
        target: { nodeType: 1, closest: () => null }
      }]),
      painted: () => paintedAnchors.length,
    };
  `,
  )
  return {
    ...(run(build, paint, send, source, root, setTimeout, clearTimeout) as {
      apply: () => void
      mutate: (attribute?: string) => void
      painted: () => number
    }),
    source,
    build,
    paint,
    send,
  }
}

afterEach(() => vi.useRealTimers())

test.each([true, false])(
  'a later exclusion cannot be undone by a debounce (parent echo: %s)',
  (echo) => {
    vi.useFakeTimers()
    const f = fixture()
    f.apply()
    f.source.text = 'quote changed'
    f.mutate()
    f.source.excluded = true
    f.mutate('data-anchor-ignore')
    if (echo) f.apply()
    f.build.mockClear()
    f.paint.mockClear()
    f.send.mockClear()
    vi.advanceTimersByTime(300)
    expect(f.painted()).toBe(0)
    expect(f.paint).not.toHaveBeenCalled()
    expect(f.build).toHaveBeenCalledOnce()
    expect(
      f.send.mock.calls
        .flatMap(([message]) => message.results)
        .some((result) => result.state === 'attached'),
    ).toBe(false)
  },
)

test('a newer explicit resolution supersedes the cached observer snapshot', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.apply()
  f.source.text = 'quote changed'
  f.mutate()
  f.source.excluded = true
  f.apply()
  expect(f.painted()).toBe(0)
  f.build.mockClear()
  vi.advanceTimersByTime(300)
  expect(f.painted()).toBe(0)
  expect(f.build).toHaveBeenCalledOnce()
})

test('an unchanged snapshot is reused without a second engine construction', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.apply()
  f.build.mockClear()
  f.source.text = 'quote changed'
  f.mutate()
  vi.advanceTimersByTime(300)
  expect(f.build).toHaveBeenCalledOnce()
  expect(f.painted()).toBe(1)
})

test('invalidated paint is restored by a same-offset application before the timer', () => {
  vi.useFakeTimers()
  const f = fixture()
  f.apply()
  f.source.text = 'quote changed'
  f.source.paintedText = ''
  f.mutate()
  expect(f.painted()).toBe(0)
  f.apply()
  expect(f.painted()).toBe(1)
})

test('same-offset echoes retain paint until the background palette changes', () => {
  const f = fixture()
  f.apply()
  f.apply()
  expect(f.paint).toHaveBeenCalledOnce()
  f.source.dark = true
  f.apply()
  expect(f.paint).toHaveBeenCalledTimes(2)
})
