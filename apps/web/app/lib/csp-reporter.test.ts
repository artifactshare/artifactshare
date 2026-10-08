// @vitest-environment happy-dom
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  READY_CHECK_MESSAGE_KIND,
  READY_CHECK_MESSAGE_SOURCE,
  READY_MESSAGE_REPEAT_COUNT,
  READY_MESSAGE_REPEAT_INTERVAL_MS,
  SANDBOX_EXTERNAL_LINK_POLICY_MESSAGE,
  SANDBOX_READY_CHECK_MESSAGE,
  acceptSandboxToken,
  canUseOsHandler,
  ensureSandboxChallenge,
  isSandboxMessage,
} from './csp-reporter'
import { createReporterState } from '../../../../packages/viewer-kit/src/reporter/state.js'
import {
  createMessagePayload,
  send,
  readEventValue,
  onReadyCheck,
} from '../../../../packages/viewer-kit/src/reporter/messaging.js'
import { hitComment } from '../../../../packages/viewer-kit/src/reporter/badges.js'
import {
  handleMutations,
  installAnchorObserver,
} from '../../../../packages/viewer-kit/src/reporter/mutations.js'
import {
  svgTextRange,
  setSvgHighlightState,
} from '../../../../packages/viewer-kit/src/reporter/svg-overlay.js'
import { installMermaidResults } from '../../../../packages/viewer-kit/src/reporter/mermaid.js'

import { installCspViolations } from '../../../../packages/viewer-kit/src/reporter/csp-violations.js'

function state() {
  return createReporterState(window)
}
afterEach(() => {
  document.body.innerHTML = ''
  vi.useRealTimers()
  vi.restoreAllMocks()
})

test.each(['error', 'unhandledrejection'])(
  'CSP reporter does not infer violations from %s error messages',
  (kind) => {
    vi.useFakeTimers()
    const ctx = state()
    const post = vi.spyOn(ctx.primordials, 'savedPostMessage')
    const events = new EventTarget()
    const documentEvents = new EventTarget()
    vi.spyOn(ctx.win as EventTarget, 'addEventListener').mockImplementation(
      events.addEventListener.bind(events),
    )
    vi.spyOn(ctx.doc as EventTarget, 'addEventListener').mockImplementation(
      documentEvents.addEventListener.bind(documentEvents),
    )
    installCspViolations(ctx)
    const error = new EvalError(
      'Refused to evaluate because unsafe-eval is blocked by Content Security Policy',
    )
    events.dispatchEvent(
      Object.assign(new Event(kind), { error, reason: error }),
    )
    vi.runAllTimers()
    expect(post).not.toHaveBeenCalled()

    documentEvents.dispatchEvent(
      Object.assign(new Event('securitypolicyviolation'), {
        effectiveDirective: 'script-src',
        blockedURI: 'eval',
      }),
    )
    expect(post).toHaveBeenCalledExactlyOnceWith(
      ctx.primordials.savedParent,
      {
        source: 'artifactshare',
        kind: 'csp-violation',
        directive: 'script-src',
        blockedURI: 'eval',
        sourceFile: null,
        lineNumber: null,
      },
      '*',
    )
  },
)

describe('isSandboxMessage', () => {
  test('rejects untrusted frame control messages', () => {
    expect(
      isSandboxMessage({ source: 'artifactshare', kind: 'unauthorized' }),
    ).toBe(false)
    expect(
      isSandboxMessage({ source: 'artifactshare', kind: 'not-found' }),
    ).toBe(false)
  })

  test('accepts reporter messages', () => {
    expect(isSandboxMessage({ source: 'artifactshare', kind: 'ready' })).toBe(
      true,
    )
    expect(
      isSandboxMessage({
        source: 'artifactshare',
        kind: 'link-clicked',
        href: 'https://artifactshare.com/a/abc123def4',
      }),
    ).toBe(true)
    expect(
      isSandboxMessage({
        source: 'artifactshare',
        kind: 'mermaid-render-request',
        renderToken: 'current-document',
        diagrams: [
          { id: 'artifactshare-mermaid-0', source: 'flowchart LR\nA --> B' },
        ],
      }),
    ).toBe(true)
    expect(
      isSandboxMessage({
        source: 'artifactshare',
        kind: 'ready',
        challenge: 'c',
        token: 't',
      }),
    ).toBe(true)
    expect(
      isSandboxMessage({
        source: 'artifactshare',
        kind: 'link-clicked',
        href: '/x',
        token: 't',
      }),
    ).toBe(true)
  })

  test('rejects malformed security fields', () => {
    expect(
      isSandboxMessage({ source: 'artifactshare', kind: 'ready', token: 1 }),
    ).toBe(false)
    expect(
      isSandboxMessage({
        source: 'artifactshare',
        kind: 'mermaid-render-request',
        renderToken: 'current-document',
        diagrams: [{ id: '../other', source: 'flowchart LR' }],
      }),
    ).toBe(false)
    expect(
      isSandboxMessage({
        source: 'artifactshare',
        kind: 'mermaid-render-request',
        renderToken: '',
        diagrams: [{ id: 'artifactshare-mermaid-0', source: 'flowchart LR' }],
      }),
    ).toBe(false)
    expect(
      isSandboxMessage({
        source: 'artifactshare',
        kind: 'link-clicked',
        href: '/x',
        token: 1,
      }),
    ).toBe(false)
  })
})

describe('security acceptance helpers', () => {
  test('reuses a challenge for probes and creates a fresh one when absent', () => {
    const first = ensureSandboxChallenge(null)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(ensureSandboxChallenge(first)).toBe(first)
    expect(ensureSandboxChallenge(null)).not.toBe(first)
  })

  test('registers only the first non-empty token for the current challenge', () => {
    expect(acceptSandboxToken(null, 'current', 'current', '')).toBeNull()
    expect(acceptSandboxToken(null, null, 'current', 'first')).toBeNull()
    expect(acceptSandboxToken(null, 'current', 'old', 'first')).toBeNull()
    expect(acceptSandboxToken(null, 'current', 'other', 'first')).toBeNull()
    expect(acceptSandboxToken(null, 'current', 'current', 'first')).toBe(
      'first',
    )
    expect(acceptSandboxToken('first', 'current', 'current', 'second')).toBe(
      'first',
    )
  })

  test('allows OS handlers only for an active exact token', () => {
    expect(canUseOsHandler('token', 'token', true)).toBe(true)
    expect(canUseOsHandler(null, 'token', true)).toBe(false)
    expect(canUseOsHandler('token', undefined, true)).toBe(false)
    expect(canUseOsHandler('token', 'other', true)).toBe(false)
    expect(canUseOsHandler('token', 'token', false)).toBe(false)
    expect(canUseOsHandler(null, null, true)).toBe(false)
  })
})

describe('injected security primitives', () => {
  test('does not expose security fields through Object.prototype setters', () => {
    const ctx = state()
    let observed: unknown
    Object.defineProperty(Object.prototype, 'token', {
      configurable: true,
      set(value) {
        observed = value
      },
    })
    try {
      const payload = createMessagePayload(ctx.primordials, {
        kind: 'ready',
        token: 'synthetic-token',
      })
      expect(observed).toBeUndefined()
      expect(Object.getPrototypeOf(payload)).toBeNull()
      expect(payload.token).toBe('synthetic-token')
    } finally {
      delete (Object.prototype as Record<string, unknown>).token
    }
  })
  test('uses the saved parent postMessage after authored code replaces the method', () => {
    const original = window.postMessage
    const delivered = vi.fn()
    const redirected = vi.fn()
    try {
      window.postMessage = delivered
      const ctx = state()
      window.postMessage = redirected
      send(ctx, { kind: 'ready', token: 'synthetic-token' })
      expect(delivered).toHaveBeenCalledWith(
        { source: 'artifactshare', kind: 'ready', token: 'synthetic-token' },
        '*',
      )
      expect(redirected).not.toHaveBeenCalled()
    } finally {
      window.postMessage = original
    }
  })

  test('fails closed when a captured event getter is absent or throws', () => {
    const ctx = state(),
      event = new Event('click')
    expect(readEventValue(ctx, null, event)).toBeNull()
    expect(
      readEventValue(
        ctx,
        () => {
          throw new Error('unavailable')
        },
        event,
      ),
    ).toBeNull()
    expect(readEventValue(ctx, () => 0, event)).toBe(0)
  })
})

describe('text highlight hit testing', () => {
  test.each([
    { type: 'click', isTrusted: true, detail: 1, hit: true },
    { type: 'click', isTrusted: true, detail: 0, hit: false },
    { type: 'click', isTrusted: true, detail: 1, pointerType: '', hit: false },
    {
      type: 'click',
      isTrusted: true,
      detail: 1,
      mozInputSource: 6,
      hit: false,
    },
    {
      type: 'click',
      isTrusted: true,
      detail: 1,
      pointerType: 'mouse',
      mozInputSource: 1,
      hit: true,
    },
    { type: 'click', isTrusted: false, detail: 1, hit: false },
    { type: 'click', isTrusted: false, detail: 0, hit: false },
    { type: 'pointerdown', isTrusted: true, detail: 0, hit: true },
  ])(
    '$type trusted=$isTrusted detail=$detail hit=$hit',
    ({ hit, ...event }) => {
      const ctx = state()
      // Geometry and trust are browser inputs; the production hit test owns the policy.
      ctx.primordials.trustedGetter = undefined
      const badge = document.createElement('button')
      const measure = vi.fn(() => [new DOMRect(0, 0, 100, 20)])
      ctx.badges.push({
        badge,
        highlight: { threadId: 'quote', quotedText: 'quote' },
        measure,
      })
      expect(
        hitComment(ctx, { ...event, clientX: 0, clientY: 0 } as MouseEvent),
      ).toBe(hit ? badge : null)
      expect(measure).toHaveBeenCalledTimes(hit ? 1 : 0)
    },
  )
})

describe('readiness handshake', () => {
  test('keeps the repeated ready window explicit', () => {
    expect(READY_MESSAGE_REPEAT_COUNT).toBe(20)
    expect(READY_MESSAGE_REPEAT_INTERVAL_MS).toBe(100)
    expect(SANDBOX_READY_CHECK_MESSAGE).toEqual({
      source: READY_CHECK_MESSAGE_SOURCE,
      kind: READY_CHECK_MESSAGE_KIND,
    })
    expect(SANDBOX_EXTERNAL_LINK_POLICY_MESSAGE).toEqual({
      source: READY_CHECK_MESSAGE_SOURCE,
      kind: 'external-link-policy',
      mode: 'parent',
    })
  })
  test('answers only parent ready checks with a nonempty challenge', () => {
    const ctx = state()
    ctx.documentToken = 'synthetic-token'
    const post = vi.fn()
    ctx.primordials.savedPostMessage = post
    const data = {
      ...SANDBOX_READY_CHECK_MESSAGE,
      challenge: 'synthetic-challenge',
    }
    onReadyCheck(ctx, new MessageEvent('message', { source: null, data }))
    onReadyCheck(
      ctx,
      new MessageEvent('message', {
        source: window,
        data: { ...data, challenge: '' },
      }),
    )
    expect(post).not.toHaveBeenCalled()
    onReadyCheck(ctx, new MessageEvent('message', { source: window, data }))
    expect(post).toHaveBeenCalledWith(
      window,
      {
        source: 'artifactshare',
        kind: 'ready',
        token: 'synthetic-token',
        challenge: 'synthetic-challenge',
      },
      '*',
    )
    expect(Object.getPrototypeOf(post.mock.calls[0]![1])).toBeNull()
  })
})

test('observer watches ancestors but ignores reporter-owned attributes and unrelated text', () => {
  document.body.innerHTML =
    '<main data-comment-content>quote</main><aside data-anchor-ignore></aside>'
  const ctx = state()
  ctx.pendingHighlights = [{ threadId: 'quote', quotedText: 'quote' }]
  const schedule = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
  const observe = vi.spyOn(window.MutationObserver.prototype, 'observe')
  const observer = installAnchorObserver(ctx)
  expect(observe).toHaveBeenCalledWith(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  })
  const record = (target: Node, type: MutationRecordType) =>
    ({ target, type, attributeName: 'style' }) as MutationRecord
  handleMutations(ctx, [record(document.body, 'attributes')])
  expect(schedule).toHaveBeenCalledOnce()
  expect(ctx.resolveTimer).toBeUndefined()
  ctx.badgePositionFrame = 0
  handleMutations(ctx, [record(document.querySelector('aside')!, 'attributes')])
  handleMutations(ctx, [record(document.body, 'characterData')])
  expect(schedule).toHaveBeenCalledOnce()
  expect(observe).toHaveBeenCalledOnce()
  observer.disconnect()
})

describe('SVG source-to-glyph mapping', () => {
  function mapSvgRange(
    value: string,
    quote: string,
    count: number,
    inTspan = true,
  ) {
    document.body.innerHTML =
      '<svg><text>\n  <tspan>First</tspan>\n  <tspan id="selected"></tspan>\n</text></svg>'
    const text = document.querySelector('text')!
    let container = inTspan ? document.querySelector('#selected')! : text
    if (!inTspan) text.textContent = ''
    container.textContent = value
    Object.defineProperty(text, 'getNumberOfChars', {
      value: () => (inTspan ? 12 : count),
      configurable: true,
    })
    if (inTspan)
      Object.defineProperty(container, 'getNumberOfChars', {
        value: () => count,
      })
    const range = document.createRange()
    range.setStart(container.firstChild!, value.indexOf(quote))
    range.setEnd(container.firstChild!, value.indexOf(quote) + quote.length)
    return { groups: svgTextRange(state(), [range]), container }
  }
  test('uses tspan-local glyph indexes despite indentation and sibling text', () => {
    const { groups, container } = mapSvgRange('Second', 'Second', 6)
    expect(groups).toEqual([{ text: container, start: 0, end: 6 }])
  })
  test('maps collapsed whitespace within a text content element', () => {
    const { groups, container } = mapSvgRange(
      'First    Second',
      'Second',
      12,
      false,
    )
    expect(groups).toEqual([{ text: container, start: 6, end: 12 }])
  })
  test('keeps preserved whitespace indexes when SVG reports every character', () => {
    const { groups, container } = mapSvgRange('First    Second', 'Second', 15)
    expect(groups).toEqual([{ text: container, start: 9, end: 15 }])
  })
  test('does not invent indexes when neither source map agrees with the browser', () => {
    expect(mapSvgRange('Second', 'Second', 99).groups).toEqual([])
  })
})

test('SVG state changes ignore a forged state label and retain unchanged styles', () => {
  document.body.innerHTML =
    '<svg><rect class="ash-comment-highlight-svg" data-thread-id="svg" data-palette="rgba(255, 200, 0, 0.2)|orange" /></svg>'
  const overlay = document.querySelector('rect')!
  const ctx = state()
  setSvgHighlightState(ctx, 'svg', false)
  expect(overlay.style.stroke).toBe('none')
  overlay.dataset.state = 'active'
  setSvgHighlightState(ctx, 'svg', true)
  expect(overlay.style.stroke).toBe('orange')
  expect(overlay.style.strokeWidth).toBe('2')
  overlay.dataset.state = 'normal'
  setSvgHighlightState(ctx, 'svg', false)
  expect(overlay.style.stroke).toBe('none')
  expect(overlay.style.strokeWidth).toBe('0')
  const styleWrite = vi.fn((target, key, value) =>
    Reflect.set(target, key, value),
  )
  Object.defineProperty(overlay, 'style', {
    value: new Proxy(overlay.style, { set: styleWrite }),
  })
  const write = vi.spyOn(ctx.svgOverlayStyles, 'set')
  setSvgHighlightState(ctx, 'svg', false)
  expect(write).not.toHaveBeenCalled()
  expect(styleWrite).not.toHaveBeenCalled()
  setSvgHighlightState(ctx, 'svg', true)
  expect(styleWrite).toHaveBeenCalled()
  expect(overlay.style.stroke).toBe('orange')
})

test('payload copying never invokes replaceable key-array iterators', () => {
  const ctx = state()
  const message = {
    kind: 'ready',
    challenge: 'synthetic-challenge',
    token: 'synthetic-token',
  }
  let messageReads = 0
  let iteratorCalls = 0
  Object.setPrototypeOf(message, {
    get injected() {
      messageReads++
      return message.token
    },
  })
  const objectKeys = ctx.primordials.objectKeys
  const payload = createMessagePayload(
    {
      objectCreate: ctx.primordials.objectCreate,
      objectKeys(value) {
        const keys = objectKeys(value)
        // Models an authored iterator yielding an inherited key. Do not poison
        // the runner's realm: the generated-output browser test does that in a frame.
        keys[Symbol.iterator] = function* () {
          iteratorCalls++
          yield 'injected'
          for (let index = 0; index < keys.length; index++) yield keys[index]
          return undefined
        }
        return keys
      },
    },
    message,
  )
  expect(iteratorCalls).toBe(0)
  expect(messageReads).toBe(0)
  expect(Object.getPrototypeOf(payload)).toBeNull()
  expect(payload).toEqual({
    source: 'artifactshare',
    kind: 'ready',
    challenge: 'synthetic-challenge',
    token: 'synthetic-token',
  })
})

test('Mermaid results tolerate a detached block and render subsequent diagrams', () => {
  const ctx = state()
  ctx.readyChallenge = 'synthetic-challenge'
  const detached = document.createElement('pre')
  const attached = document.createElement('pre')
  document.body.appendChild(detached)
  document.body.appendChild(attached)
  ctx.mermaidBlocks = { detached, attached }
  detached.remove()
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><text>Diagram</text></svg>'
  installMermaidResults(ctx, ctx.readyChallenge, [
    { id: 'detached', svg },
    { id: 'attached', svg },
  ])
  expect(document.querySelectorAll('.mermaid-diagram')).toHaveLength(1)
  expect(attached.previousElementSibling?.textContent).toBe('Diagram')
  expect(attached.hidden).toBe(true)
  expect(ctx.mermaidBlocks).toEqual({})
})

const validCspReport = {
  source: 'artifactshare',
  kind: 'csp-violation',
  directive: 'script-src',
  blockedURI: 'eval',
  sourceFile: null,
  lineNumber: null,
}
test.each([
  {},
  { sample: '', disposition: 'enforce' },
  { sample: 'a'.repeat(80), disposition: 'report' },
])('accepts legacy and optional CSP metadata %j', (metadata) => {
  expect(isSandboxMessage({ ...validCspReport, ...metadata })).toBe(true)
})
test.each([
  { directive: null },
  { blockedURI: 1 },
  { sourceFile: 3 },
  { sourceFile: undefined },
  { lineNumber: undefined },
  { lineNumber: -1 },
  { lineNumber: Infinity },
  { lineNumber: NaN },
  { lineNumber: '1' },
  { sample: null },
  { sample: 2 },
  { sample: 'a'.repeat(81) },
  { disposition: 'other' },
  { disposition: null },
])('rejects malformed CSP report %j', (invalid) => {
  expect(isSandboxMessage({ ...validCspReport, ...invalid })).toBe(false)
})
test.each([0, 80, 81, 200])(
  'emits at most 80 UTF-16 units from a %i-unit sample',
  (length) => {
    const ctx = state()
    const post = vi.spyOn(ctx.primordials, 'savedPostMessage')
    const events = new EventTarget()
    vi.spyOn(ctx.doc as EventTarget, 'addEventListener').mockImplementation(
      events.addEventListener.bind(events),
    )
    installCspViolations(ctx)
    for (const disposition of ['enforce', 'report']) {
      events.dispatchEvent(
        Object.assign(new Event('securitypolicyviolation'), {
          effectiveDirective: 'script-src',
          blockedURI: 'eval',
          sample: 'x'.repeat(length),
          disposition,
        }),
      )
      expect(post).toHaveBeenLastCalledWith(
        ctx.primordials.savedParent,
        {
          ...validCspReport,
          sample: 'x'.repeat(Math.min(length, 80)),
          disposition,
        },
        '*',
      )
    }
  },
)
