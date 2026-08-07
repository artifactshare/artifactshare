import { describe, expect, test } from 'vitest'
import {
  READY_CHECK_MESSAGE_KIND,
  READY_CHECK_MESSAGE_SOURCE,
  READY_MESSAGE_REPEAT_COUNT,
  READY_MESSAGE_REPEAT_INTERVAL_MS,
  SAFE_EVENT_VALUE_SCRIPT,
  SANDBOX_READY_CHECK_MESSAGE,
  SECURE_MESSAGE_PAYLOAD_SCRIPT,
  VIOLATION_REPORTER_SCRIPT_BODY,
  VIOLATION_REPORTER_SHA256,
  acceptSandboxToken,
  canUseOsHandler,
  ensureSandboxChallenge,
  isSandboxMessage,
} from './csp-reporter'

describe('VIOLATION_REPORTER_SHA256', () => {
  test('matches the SHA-256 of the script body', async () => {
    const bytes = new TextEncoder().encode(VIOLATION_REPORTER_SCRIPT_BODY)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const base64 = btoa(String.fromCharCode(...new Uint8Array(digest)))
    expect(base64).toBe(VIOLATION_REPORTER_SHA256)
  })
})

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
    const createMessagePayload = new Function(
      'objectCreate',
      'objectKeys',
      `${SECURE_MESSAGE_PAYLOAD_SCRIPT}; return createMessagePayload`,
    )(Object.create, Object.keys) as (
      message: Record<string, unknown>,
    ) => Record<string, unknown>
    let observed: unknown
    Object.defineProperty(Object.prototype, 'token', {
      configurable: true,
      set(value) {
        observed = value
      },
    })
    try {
      const payload = createMessagePayload({ kind: 'ready', token: 'secret' })
      expect(observed).toBeUndefined()
      expect(Object.getPrototypeOf(payload)).toBeNull()
      expect(payload.token).toBe('secret')
    } finally {
      delete (Object.prototype as Record<string, unknown>).token
    }
  })

  test('fails closed when a captured event getter is absent or throws', () => {
    const readEventValue = new Function(
      `${SAFE_EVENT_VALUE_SCRIPT}; return readEventValue`,
    )() as (
      getter: ((event: object) => unknown) | null,
      event: object,
    ) => unknown
    expect(readEventValue(null, {})).toBeNull()
    expect(
      readEventValue(() => {
        throw new Error('unavailable')
      }, {}),
    ).toBeNull()
    expect(readEventValue(() => 0, {})).toBe(0)
  })
})

describe('SVG and fallback highlight contracts', () => {
  test('keeps generated reporter measurement and accessibility contracts', () => {
    const body = VIOLATION_REPORTER_SCRIPT_BODY
    expect(body).toContain('entry.mark.getClientRects()')
    expect(body).toContain('getExtentOfChar')
    expect(body).toContain('first.getBoundingClientRect')
    expect(body).toContain('svg.getBoundingClientRect')
    expect(body).toContain('new DOMPoint')
    expect(body).toContain('parentCtm.inverse().multiply(textCtm)')
    expect(body).toContain('dataset.target')
    expect(body).toContain('style.stroke')
    expect(body).toContain('function isDarkBackgroundForSvgText')
    expect(body).toContain(
      'rgbToLuminance(parsed.r, parsed.g, parsed.b) >= 0.5',
    )
    expect(body).toContain("status === 'resolved'")
    expect(body).toContain('M20 6 9 17')
    expect(body).toContain('M21 15a4 4')
    expect(body).toContain('badges.length > 0')
    expect(body).toContain('scroll-to-comment')
    expect(body).toContain('clearMarks')
    expect(body).toContain('acceptsAnchorText')
    expect(body).toContain('quotedText: quotedText')
  })
})

describe('readiness handshake', () => {
  test('keeps the repeated ready window explicit', () => {
    expect(READY_MESSAGE_REPEAT_COUNT).toBe(20)
    expect(READY_MESSAGE_REPEAT_INTERVAL_MS).toBe(100)
  })

  test('generated reporter answers parent ready checks', () => {
    expect(SANDBOX_READY_CHECK_MESSAGE).toEqual({
      source: READY_CHECK_MESSAGE_SOURCE,
      kind: READY_CHECK_MESSAGE_KIND,
    })
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(READY_CHECK_MESSAGE_SOURCE)
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(READY_CHECK_MESSAGE_KIND)
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      "addEventListener(window, 'click', prepareLinkClick, true)",
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      "addEventListener(window, 'click', finishLinkClick)",
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).not.toContain(
      "url.protocol === 'mailto:' || url.protocol === 'tel:'",
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      "window.open(href, '_blank', 'noopener,noreferrer')",
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain('var savedParent = parent')
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      'event.source !== savedParent',
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      'Function.prototype.call.bind',
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      'var closest = Function.prototype.call.bind(Element.prototype.closest)',
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      'var getAttribute = Function.prototype.call.bind(Element.prototype.getAttribute)',
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      'var hasAttribute = Function.prototype.call.bind(Element.prototype.hasAttribute)',
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      'var preventDefault = Function.prototype.call.bind(Event.prototype.preventDefault)',
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      'Function.prototype.call.bind(targetGetter.get)',
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      'function readEventValue(getter, event)',
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).not.toContain('Object.assign(')
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      'var payload = objectCreate(null)',
    )
  })
})

describe('generated reporter link-click exclusion contract', () => {
  test('generated reporter retains the link capture highlight and badge selector', () => {
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      "closest(element, '.ash-comment-highlight, .ash-comment-highlight-badge')",
    )
  })
})
