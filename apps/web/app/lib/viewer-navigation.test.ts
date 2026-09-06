import { describe, expect, test, vi } from 'vitest'
import {
  classifyViewerLinkNavigation,
  externalNavigationDecision,
  externalNavigationDestination,
  continueExternalNavigation,
  hasBrowserUserActivation,
  linkNavigationModeFor,
} from './viewer-navigation'

const base = {
  appOrigin: 'https://artifactshare.com',
  appHosts: ['artifactshare.com', 'www.artifactshare.com'],
  sandboxOrigin: 'https://md123abcde.sandbox.artifactshare.com',
} as const

describe('hasBrowserUserActivation', () => {
  test('accepts active browser user activation', () => {
    expect(hasBrowserUserActivation({ isActive: true })).toBe(true)
  })

  test.each([{ isActive: false }, undefined, null])(
    'rejects inactive or unavailable user activation',
    (userActivation) => {
      expect(hasBrowserUserActivation(userActivation)).toBe(false)
    },
  )
})

describe('linkNavigationModeFor', () => {
  test('keeps static sites in site mode and single documents in document mode', () => {
    expect(linkNavigationModeFor('static_site')).toBe('site')
    expect(linkNavigationModeFor('md')).toBe('document')
    expect(linkNavigationModeFor('html')).toBe('document')
  })
})

describe('externalNavigationDecision', () => {
  const external = {
    kind: 'open-external',
    url: 'https://example.com/',
    disposition: 'new-tab',
  } as const

  test('interposes only low-trust external navigation', () => {
    expect(externalNavigationDecision(external, true)).toBe('interstitial')
    expect(externalNavigationDecision(external, false)).toBe('open')
    expect(
      externalNavigationDecision(
        { kind: 'open-app', url: 'https://artifactshare.com/' },
        true,
      ),
    ).toBe('open')
  })
})

describe('external navigation interstitial', () => {
  test('shows a hostname for web links and the full target for OS handlers', () => {
    expect(externalNavigationDestination('https://example.com/path?q=1')).toBe(
      'example.com',
    )
    expect(externalNavigationDestination('mailto:user@example.com')).toBe(
      'mailto:user@example.com',
    )
  })

  test('caps attacker-controlled scheme destinations at 200 characters', () => {
    const destination = externalNavigationDestination(
      `custom:${'x'.repeat(300)}`,
    )
    expect(destination).toHaveLength(200)
    expect(destination.endsWith('…')).toBe(true)
  })

  test('continues OS handlers in place and web links in a new tab', () => {
    const browser = {
      location: { href: 'https://artifactshare.com/a/abc' },
      open: (..._args: string[]) => null,
    }
    const open = vi.spyOn(browser, 'open')

    continueExternalNavigation(
      {
        kind: 'open-external',
        url: 'mailto:user@example.com',
        disposition: 'os-handler',
      },
      browser,
    )
    expect(browser.location.href).toBe('mailto:user@example.com')
    expect(open).not.toHaveBeenCalled()

    continueExternalNavigation(
      {
        kind: 'open-external',
        url: 'https://example.com/',
        disposition: 'new-tab',
      },
      browser,
    )
    expect(open).toHaveBeenCalledWith(
      'https://example.com/',
      '_blank',
      'noopener,noreferrer',
    )
  })
})

describe('classifyViewerLinkNavigation', () => {
  test('opens Artifact Share links outside the iframe', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'document',
        href: 'https://artifactshare.com/a/abc123def4',
      }),
    ).toEqual({
      kind: 'open-app',
      url: 'https://artifactshare.com/a/abc123def4',
    })
  })

  test('opens Artifact Share links for known app hosts in a new tab', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'document',
        href: 'https://www.artifactshare.com/a/abc123def4',
      }),
    ).toEqual({
      kind: 'open-app',
      url: 'https://www.artifactshare.com/a/abc123def4',
    })
  })

  test('opens per-ID link viewer URLs as app navigation', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'document',
        href: 'https://abc123def4.artifactshare.link/',
      }),
    ).toEqual({
      kind: 'open-app',
      url: 'https://abc123def4.artifactshare.link/',
    })
  })

  test('opens external web links outside the iframe', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'document',
        href: 'https://example.com/report',
      }),
    ).toEqual({
      kind: 'open-external',
      url: 'https://example.com/report',
      disposition: 'new-tab',
    })
  })

  test('turns same-origin document links into a viewer message instead of a token error', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'document',
        href: 'https://md123abcde.sandbox.artifactshare.com/other.md',
      }),
    ).toEqual({
      kind: 'unavailable-in-document',
      url: 'https://md123abcde.sandbox.artifactshare.com/other.md',
    })
  })

  test('allows static site links to stay inside the iframe', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'site',
        bundlePaths: ['/index.html', '/about'],
        href: 'https://md123abcde.sandbox.artifactshare.com/about',
      }),
    ).toEqual({
      kind: 'allow-frame',
      url: 'https://md123abcde.sandbox.artifactshare.com/about',
    })
  })

  test('allows static site client routes when the bundle falls back to index', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'site',
        bundlePaths: ['/index.html'],
        fallbackToIndex: true,
        href: 'https://md123abcde.sandbox.artifactshare.com/dashboard',
      }),
    ).toEqual({
      kind: 'allow-frame',
      url: 'https://md123abcde.sandbox.artifactshare.com/dashboard',
    })
  })

  test('turns missing static site links into a viewer message', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'site',
        bundlePaths: ['/index.html', '/other.md'],
        href: 'https://md123abcde.sandbox.artifactshare.com/missing.md',
      }),
    ).toEqual({
      kind: 'unavailable-in-document',
      url: 'https://md123abcde.sandbox.artifactshare.com/missing.md',
    })
  })

  test('keeps missing extension paths unavailable even when fallback is enabled', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'site',
        bundlePaths: ['/index.html'],
        fallbackToIndex: true,
        href: 'https://md123abcde.sandbox.artifactshare.com/missing.md',
      }),
    ).toEqual({
      kind: 'unavailable-in-document',
      url: 'https://md123abcde.sandbox.artifactshare.com/missing.md',
    })
  })

  test('normalizes bundle paths before checking availability', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'site',
        bundlePaths: ['/index.html'],
        href: 'https://md123abcde.sandbox.artifactshare.com/INDEX.HTML',
      }),
    ).toEqual({
      kind: 'allow-frame',
      url: 'https://md123abcde.sandbox.artifactshare.com/INDEX.HTML',
    })
  })

  test('does not throw on malformed encoded paths', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'site',
        bundlePaths: ['/index.html'],
        href: 'https://md123abcde.sandbox.artifactshare.com/%E0%A4%A',
      }),
    ).toEqual({
      kind: 'unavailable-in-document',
      url: 'https://md123abcde.sandbox.artifactshare.com/%E0%A4%A',
    })
  })

  test('only treats canonical HTTPS app hosts as app links', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'document',
        href: 'http://artifactshare.com/a/abc123def4',
      }),
    ).toEqual({
      kind: 'open-external',
      url: 'http://artifactshare.com/a/abc123def4',
      disposition: 'new-tab',
    })
  })

  test('blocks unsupported schemes', () => {
    expect(
      classifyViewerLinkNavigation({
        ...base,
        mode: 'document',
        href: 'javascript:alert(1)',
      }),
    ).toEqual({ kind: 'blocked', reason: 'unsupported-scheme' })
  })

  test.each([
    ['mailto:user@example.com', 'mailto:user@example.com'],
    ['tel:+123456789', 'tel:+123456789'],
    ['cursor://any/path?x=1', 'cursor://any/path?x=1'],
    ['vscode://file/workspace', 'vscode://file/workspace'],
    ['codex://threads/new', 'codex://threads/new'],
    ['claude://code/new', 'claude://code/new'],
    [
      'claude-cli://open?repo=acme/payments&q=Review%20the%20failure',
      'claude-cli://open?repo=acme/payments&q=Review%20the%20failure',
    ],
  ])('opens %s through the OS handler', (href, url) => {
    expect(
      classifyViewerLinkNavigation({ ...base, mode: 'document', href }),
    ).toEqual({ kind: 'open-external', url, disposition: 'os-handler' })
  })

  test.each(['chatgpt://new', 'tg://resolve', 'vscode-insiders://file/a'])(
    'blocks unapproved scheme %s',
    (href) => {
      expect(
        classifyViewerLinkNavigation({ ...base, mode: 'document', href }),
      ).toEqual({ kind: 'blocked', reason: 'unsupported-scheme' })
    },
  )
})
