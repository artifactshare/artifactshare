import { describe, expect, test } from 'vitest'
import {
  commentLocationFromUrl,
  commentLocationHref,
  isCommentLocationServed,
  parseCommentLocation,
} from '@artifactshare/viewer-kit/reporter/comment-location'

describe('static-site comment locations', () => {
  test('in-page fragments are not part of the location; hash routes are', () => {
    for (const hash of ['', '#', '#intro', '#section-2', '#billing', '#top'])
      expect(commentLocationFromUrl('/page.html', hash)).toBe('/page.html')
    expect(commentLocationFromUrl('/index.html', '#/billing')).toBe(
      '/index.html#/billing',
    )
    expect(commentLocationFromUrl('/index.html', '#!/settings')).toBe(
      '/index.html#!/settings',
    )
    expect(commentLocationFromUrl('/index.html', '#/billing')).not.toBe(
      commentLocationFromUrl('/index.html', '#/settings'),
    )
    expect(commentLocationFromUrl('/index.html', '#/billing')).not.toBe(
      commentLocationFromUrl('/index.html', '#!/billing'),
    )
  })

  test('pathnames follow delivery normalization', () => {
    expect(commentLocationFromUrl('/', '')).toBe('/index.html')
    expect(commentLocationFromUrl('/INDEX.HTML', '')).toBe('/index.html')
    expect(commentLocationFromUrl('/docs/', '')).toBe('/docs')
    expect(commentLocationFromUrl('/caf%C3%A9.html', '')).toBe('/café.html')
    expect(commentLocationFromUrl('/cafe%CC%81.html', '')).toBe('/café.html')
    expect(commentLocationFromUrl('/my%20page.html', '')).toBe('/my page.html')
    for (const pathname of [
      '/docs/%2E%2E/index.html',
      '/a%00.html',
      '/bad%E9.html',
      '/a%3Fb.html',
      '/run.sh',
    ])
      expect(commentLocationFromUrl(pathname, '')).toBeNull()
  })

  test('route fragments canonicalize once and idempotently', () => {
    const literal = commentLocationFromUrl('/index.html', '#/café')
    expect(literal).toBe('/index.html#/caf%C3%A9')
    expect(commentLocationFromUrl('/index.html', '#/caf%C3%A9')).toBe(literal)
    expect(parseCommentLocation(literal)?.location).toBe(literal)
    // Encoded separators stay distinct from route separators and from a
    // twice-encoded escape.
    const encodedSlash = commentLocationFromUrl('/index.html', '#/a%2Fb')
    expect(encodedSlash).toBe('/index.html#/a%2Fb')
    expect(encodedSlash).not.toBe(
      commentLocationFromUrl('/index.html', '#/a/b'),
    )
    expect(commentLocationFromUrl('/index.html', '#/a%252Fb')).toBe(
      '/index.html#/a%252Fb',
    )
    expect(commentLocationFromUrl('/index.html', '#/caf%E9')).toBeNull()
    expect(parseCommentLocation('/index.html#/a%252Fb')?.location).toBe(
      '/index.html#/a%252Fb',
    )
  })

  test('unencodable text is rejected rather than thrown', () => {
    expect(parseCommentLocation('/index.html#/\ud800')).toBeNull()
    expect(parseCommentLocation('/index.html#/a?q=\ud800')).toBeNull()
    expect(parseCommentLocation('/\ud800.html')).toBeNull()
    expect(
      isCommentLocationServed(
        '/index.html#/\ud800',
        new Set(['/index.html']),
        true,
      ),
    ).toBe(false)
  })

  test('a hash route query keeps its path and query when reopened', () => {
    const location = commentLocationFromUrl('/index.html', '#/search?q=a&b=c+d')
    expect(location).toBe('/index.html#/search?q=a&b=c+d')
    expect(commentLocationHref(location ?? '')).toBe(
      '/index.html#/search?q=a&b=c+d',
    )
    expect(commentLocationFromUrl('/index.html', '#/search?q=caf%C3%A9')).toBe(
      commentLocationFromUrl('/index.html', '#/search?q=café'),
    )
    // An encoded `?` is part of the route path, a different route.
    expect(commentLocationFromUrl('/index.html', '#/search%3Fq%3Da')).not.toBe(
      location,
    )
  })

  test('posted locations must be canonical and inside the version', () => {
    const files = new Set(['/index.html', '/docs/page.html'])
    expect(isCommentLocationServed('/docs/page.html', files, false)).toBe(true)
    expect(isCommentLocationServed('/index.html#/billing', files, false)).toBe(
      true,
    )
    expect(isCommentLocationServed('/settings', files, false)).toBe(false)
    expect(isCommentLocationServed('/settings', files, true)).toBe(true)
    expect(isCommentLocationServed('/settings#/tab', files, true)).toBe(true)
    for (const location of [
      '/missing.html',
      '/docs/page.html#intro',
      '//evil.example/docs/page.html',
      'https://evil.example/index.html',
      '/docs/../index.html',
      '/index.html#/café',
    ])
      expect(isCommentLocationServed(location, files, true)).toBe(false)
    expect(isCommentLocationServed('/settings', new Set(), true)).toBe(false)
  })

  test('the site root stays `/` with fallback to index and is /index.html without', () => {
    const files = new Set(['/index.html'])
    // Ordinary multi-page sites keep today's root normalization.
    expect(commentLocationFromUrl('/', '')).toBe('/index.html')
    expect(isCommentLocationServed('/index.html', files, false)).toBe(true)
    expect(isCommentLocationServed('/', files, false)).toBe(false)
    expect(commentLocationHref('/index.html')).toBe('/index.html')
    // An SPA's root route reopens as `/`, which its router recognizes.
    expect(commentLocationFromUrl('/', '', true)).toBe('/')
    expect(commentLocationFromUrl('/', '#/billing', true)).toBe('/#/billing')
    expect(commentLocationFromUrl('/index.html', '', true)).toBe('/index.html')
    expect(parseCommentLocation('/', true)?.location).toBe('/')
    expect(isCommentLocationServed('/', files, true)).toBe(true)
    expect(isCommentLocationServed('/', new Set(), true)).toBe(false)
    expect(isCommentLocationServed('/index.html', files, true)).toBe(true)
    expect(commentLocationHref('/', true)).toBe('/')
    expect(commentLocationHref('/#/billing', true)).toBe('/#/billing')
  })

  test('navigation encodes pathname segments and keeps the route hash', () => {
    expect(commentLocationHref('/my page.html')).toBe('/my%20page.html')
    expect(commentLocationHref('/index.html#/caf%C3%A9')).toBe(
      '/index.html#/caf%C3%A9',
    )
    expect(commentLocationHref('/settings')).toBe('/settings')
  })
})
