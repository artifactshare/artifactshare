import { describe, expect, test } from 'vitest'
import {
  classifyViewerLinkNavigation,
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
