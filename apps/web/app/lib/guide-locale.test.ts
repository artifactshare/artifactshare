import { describe, expect, test } from 'vitest'

import {
  getUpdatesDetailSlug,
  isPublicPagePath,
  pathGuideLocale,
} from '~/lib/guide-locale'

describe('guide-locale updates paths', () => {
  test('treats the landing URL pair as public', () => {
    expect(isPublicPagePath('/')).toBe(true)
    expect(isPublicPagePath('/ja')).toBe(true)
    expect(pathGuideLocale('/')).toBe('en')
    expect(pathGuideLocale('/ja')).toBe('ja')
  })
  test('treats CLI guides as public locale pairs', () => {
    expect(isPublicPagePath('/guides/cli')).toBe(true)
    expect(isPublicPagePath('/ja/guides/cli')).toBe(true)
    expect(pathGuideLocale('/guides/cli')).toBe('en')
    expect(pathGuideLocale('/ja/guides/cli')).toBe('ja')
  })
  test('treats workspace role guides as public locale pairs', () => {
    expect(isPublicPagePath('/guides/workspace-owner')).toBe(true)
    expect(isPublicPagePath('/ja/guides/workspace-owner')).toBe(true)
    expect(isPublicPagePath('/guides/workspace-admin')).toBe(true)
    expect(isPublicPagePath('/ja/guides/workspace-admin')).toBe(true)
    expect(pathGuideLocale('/guides/workspace-owner')).toBe('en')
    expect(pathGuideLocale('/ja/guides/workspace-admin')).toBe('ja')
  })
  test('treats link sharing guides as public locale pairs', () => {
    expect(isPublicPagePath('/guides/link-sharing')).toBe(true)
    expect(isPublicPagePath('/ja/guides/link-sharing')).toBe(true)
    expect(pathGuideLocale('/guides/link-sharing')).toBe('en')
    expect(pathGuideLocale('/ja/guides/link-sharing')).toBe('ja')
  })
  test('treats list pages as public', () => {
    expect(isPublicPagePath('/updates')).toBe(true)
    expect(isPublicPagePath('/ja/updates')).toBe(true)
    expect(pathGuideLocale('/updates')).toBe('en')
    expect(pathGuideLocale('/ja/updates')).toBe('ja')
  })

  test('treats detail pages as public with prefix matching', () => {
    expect(isPublicPagePath('/updates/2026-07-02-link-share-ogp')).toBe(true)
    expect(isPublicPagePath('/ja/updates/2026-07-02-link-share-ogp')).toBe(true)
    expect(pathGuideLocale('/updates/2026-07-02-link-share-ogp')).toBe('en')
    expect(pathGuideLocale('/ja/updates/2026-07-02-link-share-ogp')).toBe('ja')
  })

  test('rejects invalid slug shapes', () => {
    expect(isPublicPagePath('/updates/UPPER')).toBe(false)
    expect(isPublicPagePath('/updates/foo/bar')).toBe(false)
    expect(pathGuideLocale('/updates/invalid slug')).toBeNull()
  })

  test('extracts normalized detail slugs', () => {
    expect(getUpdatesDetailSlug('/ja/updates/sample///')).toBe('sample')
    expect(getUpdatesDetailSlug('/updates/foo/bar')).toBeNull()
  })
})
