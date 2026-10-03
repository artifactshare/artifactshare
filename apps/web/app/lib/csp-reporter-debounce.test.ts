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
  const integrityStart = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function paintIntact(',
  )
  const integrityEnd = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function setCommentLabels(',
    integrityStart,
  )
  const cssStart = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function textPaintCss(',
  )
  const cssEnd = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
    '  function refreshTextPaints(',
    cssStart,
  )
  const source = {
    text: 'quote',
    excluded: false,
    paintedText: 'quote',
    dark: false,
    style: {
      isConnected: true,
      textContent:
        '.ash-comment-highlight-badge::after{content:attr(data-count);}',
    },
    node: { parentElement: { closest: () => null } },
  }
  const build = vi.fn(() => {
    const { text, excluded, node } = source
    const range = {
      startContainer: node,
      endContainer: node,
      startOffset: 0,
      endOffset: 5,
    }
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
    var paintedAnchors = [], textPaints = [], highlightNames = [], badges = [], reusableBadges = new Map();
    var resolveStartedAt = 0, resolveTimer, checkingTimer, badgePositionFrame;
    var lastResolutionSignature = '', resolutionGeneration = 0, checkingDeadlines = {};
    var documentToken = 'token', displayedVersionId = 'v1', displayedPath = '/';
    var document = {
      body: {}, documentElement: {}, querySelectorAll: () => [],
      getElementById: () => source.style,
    };
    var window = { addEventListener: () => {} };
    var observer;
    function MutationObserver(callback) { observer = callback; this.observe = () => {}; }
    function anchorRoot() { return root; }
    function clearMarks() { paintedAnchors = []; badges = []; appliedHighlightKey = ''; }
    function wrapRange(highlight, ranges) {
      paintedAnchors.push({ highlight, ranges, groups: [] });
      paint(highlight);
    }
    function isDarkBackground() { return source.dark; }
    function commentLabel(highlight) { return String(highlight.count || 1); }
    function positionBadges() {}
    function schedulePositionBadges() {}
    function scheduleChecking() {}
    function verifyAnchors() {}
    function missingState() { return 'checking'; }
    ${VIOLATION_REPORTER_SCRIPT_BODY.slice(integrityStart, integrityEnd)}
    ${VIOLATION_REPORTER_SCRIPT_BODY.slice(cssStart, cssEnd)}
    ${VIOLATION_REPORTER_SCRIPT_BODY.slice(start, end)}
    return {
      apply: (metadata = {}) => applyHighlights([{ threadId: 'quote', quotedText: 'quote', ...metadata }]),
      highlight: () => paintedAnchors[0].highlight,
      setBadges: (entries) => { badges = entries; },
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
      apply: (metadata?: Record<string, unknown>) => void
      highlight: () => Record<string, unknown>
      setBadges: (entries: unknown[]) => void
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

test('metadata-only updates refresh the stored resolved highlight without painting', () => {
  const f = fixture()
  f.apply({ count: 1, prefixText: 'old' })
  f.apply({ count: 2, prefixText: 'new' })
  expect(f.paint).toHaveBeenCalledOnce()
  expect(f.highlight()).toMatchObject({
    count: 2,
    prefixText: 'new',
    textStart: 0,
    textEnd: 5,
  })
})

test('equal offsets on different nodes cannot reuse painted ranges', () => {
  const f = fixture()
  f.apply()
  f.source.node = { parentElement: { closest: () => null } }
  f.mutate('data-anchor-ignore')
  f.apply()
  expect(f.paint).toHaveBeenCalledTimes(2)
})

test.each(['badge', 'overlay'])(
  'removed %s prevents paint reuse',
  (removed) => {
    const f = fixture()
    f.apply()
    f.setBadges([
      {
        highlight: f.highlight(),
        badge: {
          isConnected: removed !== 'badge',
          dataset: { threadId: 'quote' },
          getAttribute: () => null,
          setAttribute: () => {},
        },
        overlays: { first: { isConnected: removed !== 'overlay' } },
      },
    ])
    f.apply()
    expect(f.paint).toHaveBeenCalledTimes(2)
  },
)

test.each(['disconnected', 'changed'])(
  '%s highlight stylesheet prevents metadata-only paint reuse',
  (damage) => {
    const f = fixture()
    f.apply()
    f.apply({ count: 2 })
    expect(f.paint).toHaveBeenCalledOnce()
    if (damage === 'disconnected') f.source.style.isConnected = false
    else f.source.style.textContent = ''
    f.apply({ count: 3 })
    expect(f.paint).toHaveBeenCalledTimes(2)
  },
)

test.each(['changed badge id', 'missing highlight'])(
  'metadata echo tolerates %s',
  (damage) => {
    const f = fixture()
    f.apply()
    const badge = {
      isConnected: true,
      dataset: { threadId: 'changed-by-page', count: '1' },
      getAttribute: () => null,
      setAttribute: () => {},
    }
    f.setBadges([
      {
        highlight:
          damage === 'missing highlight'
            ? { threadId: 'missing' }
            : f.highlight(),
        badge,
      },
    ])
    expect(() => f.apply({ count: 2 })).not.toThrow()
    if (damage === 'missing highlight') expect(f.paint).toHaveBeenCalledTimes(2)
    else {
      expect(f.paint).toHaveBeenCalledOnce()
      expect(badge.dataset).toEqual({ threadId: 'quote', count: '2' })
    }
  },
)
