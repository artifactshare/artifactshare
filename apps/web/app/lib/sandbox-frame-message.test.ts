import { describe, expect, test } from 'vitest'
import { sandboxMessageFromFrame } from './sandbox-frame-message'

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
