// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest'
import type { AnchorResolutionMessage } from './csp-reporter'
import {
  createReporterState,
  type BadgeEntry,
} from '../../../../packages/viewer-kit/src/reporter/state.js'
import { verifyAnchors } from '../../../../packages/viewer-kit/src/reporter/annotate.js'
import { installMessageListener } from '../../../../packages/viewer-kit/src/reporter/messaging.js'
import * as engines from '../../../../packages/viewer-kit/src/reporter/anchor-engine.js'
import * as svg from '../../../../packages/viewer-kit/src/reporter/svg-overlay.js'
import { applyHighlights } from '../../../../packages/viewer-kit/src/reporter/highlights.js'
import { handleMutations } from '../../../../packages/viewer-kit/src/reporter/mutations.js'

function fixture() {
  document.body.innerHTML = '<main data-comment-content>quote</main>'
  const root = document.querySelector('main')!
  const node = root.firstChild!
  const ctx = createReporterState(window)
  ctx.observedAnchorRoot = root
  ctx.documentToken = 'synthetic-token'
  ctx.displayedVersionId = 'v1'
  ctx.displayedPath = '/'
  const build = vi.spyOn(engines, 'createTextAnchorEngine')
  const paint = vi.spyOn(svg, 'wrapSvgRange')
  const send = vi.fn<(message: AnchorResolutionMessage) => void>()
  ctx.primordials.savedPostMessage = (_parent, message) =>
    send(message as unknown as AnchorResolutionMessage)
  const source = {
    get text() {
      return root.textContent || ''
    },
    set text(value: string) {
      node.textContent = value
    },
    set excluded(value: boolean) {
      root.toggleAttribute('data-anchor-ignore', value)
    },
    set paintedText(value: string) {
      if (!value)
        for (const painted of ctx.paintedAnchors)
          for (const range of painted.ranges) range.collapse(true)
    },
    set dark(value: boolean) {
      root.style.backgroundColor = value ? 'rgb(0, 0, 0)' : 'rgb(255, 255, 255)'
    },
    get style() {
      return document.getElementById('ash-comment-highlight-style')!
    },
    replaceNode() {
      root.replaceChildren(document.createTextNode(root.textContent || ''))
    },
  }
  return {
    apply: (metadata = {}) =>
      applyHighlights(ctx, [
        { threadId: 'quote', quotedText: 'quote', ...metadata },
      ]),
    highlight: () => ctx.paintedAnchors[0]!.highlight,
    setBadges: (entries: BadgeEntry[]) => {
      ctx.badges = entries
    },
    mutate: (attribute?: string) =>
      handleMutations(ctx, [
        {
          type: attribute ? 'attributes' : 'characterData',
          attributeName: attribute || null,
          target: root,
        } as unknown as MutationRecord,
      ]),
    painted: () => ctx.paintedAnchors.length,
    source,
    build,
    paint,
    send,
  }
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.body.innerHTML = ''
  document.getElementById('ash-comment-highlight-style')?.remove()
})

test('resolution signatures never expose the token to authored serialization', () => {
  vi.useFakeTimers()
  const f = fixture()
  const stringify = vi.spyOn(JSON, 'stringify')
  f.apply()
  expect(f.send).toHaveBeenCalledOnce()
  expect(f.send.mock.calls[0][0].token).toBe('synthetic-token')
  // Identical highlights still deduplicate resolution messages.
  f.apply()
  expect(f.send).toHaveBeenCalledOnce()
  const calls = stringify.mock.calls.length
  f.source.text = 'prefix quote'
  f.mutate()
  vi.advanceTimersByTime(300)
  expect(f.send).toHaveBeenCalledTimes(2)
  expect(stringify.mock.calls.length).toBeGreaterThan(calls)
  const serialized = stringify.mock.results.map((result) => result.value)
  stringify.mockRestore()
  expect(serialized.some((value) => value?.includes('synthetic-token'))).toBe(
    false,
  )
})

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
  // Isolate painter metadata from anchor resolution: both replies resolve to
  // the same production DOM ranges, despite different context metadata.
  const engine = engines.createTextAnchorEngine(document.querySelector('main')!)
  const resolved = engine.resolve({ quotedText: 'quote' })
  vi.spyOn(engine, 'resolve').mockReturnValue(resolved)
  f.build.mockReturnValue(engine)
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
  f.source.replaceNode()
  f.mutate('data-anchor-ignore')
  f.apply()
  expect(f.paint).toHaveBeenCalledTimes(2)
})

test.each(['badge', 'overlay'])(
  'removed %s prevents paint reuse',
  (removed) => {
    const f = fixture()
    f.apply()
    const badge = document.createElement('button')
    badge.dataset.threadId = 'quote'
    if (removed !== 'badge') document.body.appendChild(badge)
    const overlay = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'rect',
    )
    if (removed !== 'overlay') document.body.appendChild(overlay)
    f.setBadges([
      { highlight: f.highlight(), badge, overlays: { first: overlay } },
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
    if (damage === 'disconnected') f.source.style.remove()
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
    const badge = document.createElement('button')
    badge.dataset.threadId = 'changed-by-page'
    badge.dataset.count = '1'
    document.body.appendChild(badge)
    f.setBadges([
      {
        highlight:
          damage === 'missing highlight'
            ? { threadId: 'missing', quotedText: 'quote' }
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

test('verification deadlines expire and generations advance without mixing request ids', () => {
  vi.useFakeTimers()
  document.body.innerHTML = '<main data-comment-content>quote</main>'
  const ctx = createReporterState(window)
  ctx.pendingVerificationId = 7
  const send = vi.fn()
  ctx.primordials.savedPostMessage = send
  verifyAnchors(ctx, [
    { kind: 'text', thread: 'missing', quotedText: 'missing' },
  ])
  expect(send.mock.calls[0]![1]).toMatchObject({
    verificationId: 7,
    generation: 1,
    verdicts: [
      { thread: 'missing', attached: false, position_state: 'checking' },
    ],
  })
  vi.advanceTimersByTime(3000)
  expect(send.mock.calls.at(-1)![1]).toMatchObject({
    verificationId: 7,
    generation: 2,
    verdicts: [
      { thread: 'missing', attached: false, position_state: 'needs-check' },
    ],
  })
  expect(ctx.checkingTimer).toBeUndefined()

  const listen = vi.fn()
  ctx.primordials.savedAddEventListener = listen
  installMessageListener(ctx)
  const handle = listen.mock.calls[0]![1] as (event: MessageEvent) => void
  const data = {
    source: 'artifactshare-parent',
    kind: 'verify-anchors',
    anchors: [{ kind: 'text', thread: 'quote', quotedText: 'quote' }],
  }
  send.mockClear()
  handle(
    new MessageEvent('message', {
      source: window,
      data: { ...data, verificationId: 6 },
    }),
  )
  expect(send).not.toHaveBeenCalled()
  expect(ctx.pendingVerificationId).toBe(7)
  handle(
    new MessageEvent('message', {
      source: window,
      data: { ...data, verificationId: 8 },
    }),
  )
  expect(send.mock.calls[0]![1]).toMatchObject({
    verificationId: 8,
    generation: 3,
    verdicts: [{ thread: 'quote', attached: true, position_state: 'attached' }],
  })
})
