import { describe, expect, test, vi } from 'vitest'
import {
  READY_CHECK_MESSAGE_KIND,
  READY_CHECK_MESSAGE_SOURCE,
  READY_MESSAGE_REPEAT_COUNT,
  READY_MESSAGE_REPEAT_INTERVAL_MS,
  SAFE_EVENT_VALUE_SCRIPT,
  SANDBOX_EXTERNAL_LINK_POLICY_MESSAGE,
  SANDBOX_READY_CHECK_MESSAGE,
  SECURE_MESSAGE_PAYLOAD_SCRIPT,
  SOURCE_MAP_REFRESH_SCRIPT,
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
    expect(body).toContain('badge.dataset.count = String(highlight.count || 1)')
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
    expect(SANDBOX_EXTERNAL_LINK_POLICY_MESSAGE).toEqual({
      source: READY_CHECK_MESSAGE_SOURCE,
      kind: 'external-link-policy',
      mode: 'parent',
    })
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(READY_CHECK_MESSAGE_SOURCE)
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(READY_CHECK_MESSAGE_KIND)
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      "addEventListener(window, 'click', prepareLinkClick, true)",
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      "addEventListener(window, 'click', finishLinkClick)",
    )
    // Modified and non-primary clicks are left to the browser (as on main);
    // only plain left clicks take the gated path.
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      `      button !== 0 ||
      metaKey !== false ||
      ctrlKey !== false ||
      shiftKey !== false ||
      altKey !== false
    ) {
      return;
    }`,
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).not.toContain('auxclick')
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
      "data.mode === 'parent' || data.mode === 'direct'",
    )
    expect(VIOLATION_REPORTER_SCRIPT_BODY).toContain(
      "var externalLinkPolicyMode = 'parent'",
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

describe('source region order', () => {
  function sourceMap(values: string[], entries: Array<string | number>) {
    const clearMarks = vi.fn()
    const nodes = entries.map((entry) => {
      if (typeof entry === 'string') return { nodeType: 3, nodeValue: entry }
      const data =
        entry >= 0 ? `ash-source:${entry}` : `ash-source-end:${-entry - 1}`
      const node = { nodeType: 8, data, nodeValue: data }
      return node
    })
    const refresh = new Function(
      'nodes',
      'sourceSegments',
      'clearMarks',
      `
      var sourceMetadataInvalid = false;
      var sourceOffsets, sourceValid;
      function acceptsSourcePolicy() { return true; }
      function anchorRoot() { return { contains: function () { return true; } }; }
      var NodeFilter = { SHOW_TEXT: 4, SHOW_COMMENT: 128 };
      var document = { createTreeWalker: function () {
        var at = 0;
        return { nextNode: function () { return nodes[at++] || null; } };
      }};
      ${SOURCE_MAP_REFRESH_SCRIPT}
      return refreshSourceMap;
    `,
    )(nodes, values, clearMarks) as () => boolean
    return { refresh, nodes, clearMarks }
  }
  function validate(values: string[], entries: Array<string | number>) {
    return sourceMap(values, entries).refresh()
  }
  test('rebuilds from equal region values after replacing text and marker nodes', () => {
    const map = sourceMap(['Alpha'], [0, 'Alpha', -1])
    expect(map.refresh()).toBe(true)
    map.nodes.splice(
      0,
      map.nodes.length,
      ...map.nodes.map((node) => ({ ...node })),
    )
    expect(map.refresh()).toBe(true)
    expect(map.clearMarks).not.toHaveBeenCalled()
  })
  test('a changed region clears highlights immediately, without observer delivery', () => {
    const map = sourceMap(['Alpha'], [0, 'Alpha', -1])
    expect(map.refresh()).toBe(true)
    map.nodes[1]!.nodeValue = 'Other'
    expect(map.refresh()).toBe(false)
    expect(map.clearMarks).toHaveBeenCalledOnce()
  })
  test('missing markers clear highlights even when all text is unchanged', () => {
    const map = sourceMap(['Alpha'], [0, 'Alpha', -1])
    expect(map.refresh()).toBe(true)
    map.nodes.pop()
    expect(map.refresh()).toBe(false)
    expect(map.clearMarks).toHaveBeenCalledOnce()
  })
  test('outside text does not enter region values', () => {
    expect(validate(['Alpha'], ['Added', 0, 'Alpha', -1, 'More'])).toBe(true)
  })
  test('accepts ordered regions and repeated text nodes inside a region', () => {
    expect(
      validate(['Alpha', 'Beta'], [0, 'Al', 'pha', -1, 1, 'Beta', -2]),
    ).toBe(true)
    expect(validate(['Alpha', 'Beta'], [0, 'Alpha', 1, 'Beta', -2, -1])).toBe(
      true,
    )
  })
  test.each([
    ['Alpha', 'Beta'],
    ['Same', 'Same'],
  ])(
    'rejects reordered intact regions even when values match: %s %s',
    (first, second) => {
      expect(validate([first, second], [1, second, -2, 0, first, -1])).toBe(
        false,
      )
    },
  )
  test('rejects text reordered across nested regions with unchanged openings', () => {
    expect(validate(['Alpha', 'Beta'], [0, 1, 'Beta', -2, 'Alpha', -1])).toBe(
      false,
    )
  })
})

describe('reporter split cleanup', () => {
  test.each([
    ['unchanged pieces', 'Hello ', 'world', '!', 'Hello world!'],
    ['edited mark retains its suffix', 'Hello ', 'other', '!', 'Hello other!'],
    ['prefix insertion', 'Hello dear ', 'world', '!', 'Hello dear world!'],
    ['prefix replacement', 'Hi ', 'world', '!', 'Hi world!'],
    ['prefix deletion', '', 'world', '!', 'world!'],
    [
      'page-owned node replacement',
      'Hello earth',
      'world',
      '!',
      'Hello earthworld!',
    ],
    [
      'edited pieces with unchanged region text',
      '',
      'Hello',
      ' world!',
      'Hello world!',
    ],
  ])('%s', (_name, prefix, selected, suffix, expected) => {
    // Model the text siblings after marks are unwrapped. Exercise the actual
    // cleanup function without requiring the browser server to bind a socket.
    const children: Piece[] = []
    class Piece {
      constructor(public data: string) {
        children.push(this)
      }
      get parentNode() {
        return children.includes(this) ? children : null
      }
      get nextSibling() {
        return children[children.indexOf(this) + 1] ?? null
      }
      appendData(value: string) {
        this.data += value
      }
      remove() {
        children.splice(children.indexOf(this), 1)
      }
    }
    const original = new Piece(prefix!)
    const middle = new Piece(selected!)
    const tail = new Piece(suffix!)
    const splits = [
      {
        left: original,
        right: middle,
        leftText: 'Hello ',
        rightText: 'world!',
      },
      { left: middle, right: tail, leftText: 'world', rightText: '!' },
    ]
    const start = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
      '  function clearMarks()',
    )
    const end = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
      '  function setCommentLabels',
      start,
    )
    const cleanup = new Function(
      'document',
      'reporterSplits',
      `
      var badges = [], svgActiveThreads = {}, appliedMarks = [], highlightSignature = null;
      ${VIOLATION_REPORTER_SCRIPT_BODY.slice(start, end)}
      return clearMarks;
    `,
    )({ querySelectorAll: () => [] }, splits) as () => void
    cleanup()
    expect(children.map((node) => node.data).join('')).toBe(expected)
    expect(children[0]).toBe(original)
    if (_name === 'page-owned node replacement') {
      expect(original.data).toBe('Hello earth')
      expect(children).toEqual([original, middle])
    }
    cleanup()
    expect(children.map((node) => node.data).join('')).toBe(expected)
  })
})

describe('reporter scroll navigation', () => {
  test.each(['start', 'end', 'clone', 'svg clone', 'missing'] as const)(
    'navigates only through validated recorded marks: %s',
    (boundary) => {
      const text = { offset: 5 }
      const mark = {
        start: 5,
        end: 9,
        childNodes: [text],
        isConnected: true,
        firstChild: text,
        textContent: 'same',
        scrollIntoView: vi.fn(),
      }
      const clearMarks = vi.fn()
      const clone = { scrollIntoView: vi.fn() }
      const querySelector = vi.fn(() =>
        boundary === 'start' || boundary === 'end' ? mark : clone,
      )
      const start = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
        '  function marksAtRecordedPositions()',
      )
      const end = VIOLATION_REPORTER_SCRIPT_BODY.indexOf(
        '  function rectFromPointer',
        start,
      )
      const scroll = new Function(
        'appliedMarks',
        'badges',
        'textOffset',
        'refreshSourceMap',
        'clearMarks',
        'document',
        'CSS',
        `${VIOLATION_REPORTER_SCRIPT_BODY.slice(start, end)}\nreturn scrollToThread;`,
      )(
        boundary === 'svg clone' || boundary === 'missing'
          ? []
          : [{ mark, threadId: 'u1', start: 5, text: 'same' }],
        boundary === 'svg clone'
          ? [{ badge: mark, threadId: 'u1', measure: vi.fn() }]
          : [],
        (node: typeof text | typeof mark, offset: number) =>
          'offset' in node ? node.offset : offset === 0 ? node.start : node.end,
        () => true,
        clearMarks,
        { querySelector },
        { escape: (value: string) => value },
      ) as (id: string) => void
      scroll('u1')
      if (boundary === 'missing') {
        expect(mark.scrollIntoView).not.toHaveBeenCalled()
        expect(clone.scrollIntoView).not.toHaveBeenCalled()
        expect(querySelector).not.toHaveBeenCalled()
        return
      }
      expect(mark.scrollIntoView).toHaveBeenCalledOnce()
      expect(clearMarks).not.toHaveBeenCalled()
      expect(clone.scrollIntoView).not.toHaveBeenCalled()
      if (boundary === 'clone' || boundary === 'svg clone') return
      mark.scrollIntoView.mockClear()
      querySelector.mockClear()
      // The source region and marked quote remain identical, but the mark now
      // covers the first occurrence in "same same" instead of the second.
      if (boundary === 'start') {
        text.offset = 0
        mark.start = 0
      } else {
        // Excluded descendants can preserve textContent while the accepted
        // source text has moved outside the mark. Its start is still correct.
        mark.end = 5
      }
      scroll('u1')
      expect(clearMarks).toHaveBeenCalledOnce()
      expect(querySelector).not.toHaveBeenCalled()
      expect(mark.scrollIntoView).not.toHaveBeenCalled()
    },
  )
})
