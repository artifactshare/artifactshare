import { describe, expect, test } from 'vitest'
import {
  sandboxExternalLinkPolicyMessage,
  sandboxMessageFromFrame,
} from './sandbox-frame-message'

describe('sandboxMessageFromFrame', () => {
  const trustedOrigin = 'https://site123abc.sandbox.artifactshare.com'
  const trustedWindow = {} as Window

  function messageEvent(overrides: Partial<MessageEvent>): MessageEvent {
    return {
      origin: trustedOrigin,
      source: trustedWindow,
      data: { source: 'artifactshare', kind: 'ready' },
      ...overrides,
    } as MessageEvent
  }

  test('accepts ready and CSP violation messages from the trusted iframe', () => {
    expect(
      sandboxMessageFromFrame(
        messageEvent({ data: { source: 'artifactshare', kind: 'ready' } }),
        trustedOrigin,
        trustedWindow,
      ),
    ).toEqual({ source: 'artifactshare', kind: 'ready' })

    expect(
      sandboxMessageFromFrame(
        messageEvent({
          data: {
            source: 'artifactshare',
            kind: 'csp-violation',
            directive: 'script-src',
            blockedURI: 'https://cdn.example.com/app.js',
            sourceFile: null,
            lineNumber: null,
          },
        }),
        trustedOrigin,
        trustedWindow,
      ),
    ).toEqual({
      source: 'artifactshare',
      kind: 'csp-violation',
      directive: 'script-src',
      blockedURI: 'https://cdn.example.com/app.js',
      sourceFile: null,
      lineNumber: null,
    })

    expect(
      sandboxMessageFromFrame(
        messageEvent({
          data: {
            source: 'artifactshare',
            kind: 'link-clicked',
            href: 'https://artifactshare.com/a/abc123def4',
          },
        }),
        trustedOrigin,
        trustedWindow,
      ),
    ).toEqual({
      source: 'artifactshare',
      kind: 'link-clicked',
      href: 'https://artifactshare.com/a/abc123def4',
    })

    expect(
      sandboxMessageFromFrame(
        messageEvent({
          data: {
            source: 'artifactshare',
            kind: 'mermaid-render-request',
            renderToken: 'current-document',
            diagrams: [
              {
                id: 'artifactshare-mermaid-0',
                source: 'flowchart LR\nA --> B',
              },
            ],
          },
        }),
        trustedOrigin,
        trustedWindow,
      ),
    ).toMatchObject({ kind: 'mermaid-render-request' })
  })

  test('rejects sibling frames and non-sandbox origins', () => {
    expect(
      sandboxMessageFromFrame(
        messageEvent({ source: {} as MessageEventSource }),
        trustedOrigin,
        trustedWindow,
      ),
    ).toBeNull()

    expect(
      sandboxMessageFromFrame(
        messageEvent({ origin: 'https://evil.example.com' }),
        trustedOrigin,
        trustedWindow,
      ),
    ).toBeNull()
  })

  test('rejects unknown message shapes', () => {
    expect(
      sandboxMessageFromFrame(
        messageEvent({
          data: { source: 'artifactshare', kind: 'ready-check' },
        }),
        trustedOrigin,
        trustedWindow,
      ),
    ).toBeNull()
  })
})

test('builds the parent-owned external-link policy sent after readiness', () => {
  expect(sandboxExternalLinkPolicyMessage()).toEqual({
    source: 'artifactshare-parent',
    kind: 'external-link-policy',
    mode: 'parent',
  })
  expect(sandboxExternalLinkPolicyMessage('direct')).toEqual({
    source: 'artifactshare-parent',
    kind: 'external-link-policy',
    mode: 'direct',
  })
})

test('CSP metadata still requires the exact origin and frame identity', () => {
  const origin = 'https://site123abc.sandbox.artifactshare.com'
  const frame = {} as Window
  const data = {
    source: 'artifactshare',
    kind: 'csp-violation',
    directive: 'script-src',
    blockedURI: 'eval',
    sourceFile: null,
    lineNumber: 0,
    sample: 'eval(1)',
    disposition: 'enforce',
  }
  const event = { origin, source: frame, data } as MessageEvent
  expect(sandboxMessageFromFrame(event, origin, frame)).toEqual(data)
  expect(
    sandboxMessageFromFrame(
      { ...event, origin: 'https://example.com' } as MessageEvent,
      origin,
      frame,
    ),
  ).toBeNull()
  expect(
    sandboxMessageFromFrame(
      { ...event, source: {} } as MessageEvent,
      origin,
      frame,
    ),
  ).toBeNull()
  expect(
    sandboxMessageFromFrame(
      { ...event, data: { ...data, sample: 'x'.repeat(81) } } as MessageEvent,
      origin,
      frame,
    ),
  ).toBeNull()
})
