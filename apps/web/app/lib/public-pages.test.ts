import { describe, expect, test } from 'vitest'

import pages from '~/public-pages.json'

import { discoveredRoutes, resolveRoute } from '~/test/discovered-routes'
import { getPublicPagePath, validatePublicPageMaster } from './public-pages'

const valid = { guide: { en: '/guide', ja: '/ja/guide' } }

describe('public page master', () => {
  test('resolves locale paths', () => {
    expect(getPublicPagePath('about', 'en')).toBe('/about')
    expect(getPublicPagePath('about', 'ja')).toBe('/ja/about')
    expect(getPublicPagePath('getting-started', 'en')).toBe('/start')
    expect(getPublicPagePath('getting-started', 'ja')).toBe('/ja/start')
    expect(getPublicPagePath('guides-cli', 'en')).toBe('/guides/cli')
    expect(getPublicPagePath('guides-cli', 'ja')).toBe('/ja/guides/cli')
    expect(getPublicPagePath('guides-workspace-owner', 'en')).toBe(
      '/guides/workspace-owner',
    )
    expect(getPublicPagePath('guides-workspace-admin', 'ja')).toBe(
      '/ja/guides/workspace-admin',
    )
    expect(getPublicPagePath('guides-link-sharing', 'en')).toBe(
      '/guides/link-sharing',
    )
    expect(getPublicPagePath('guides-link-sharing', 'ja')).toBe(
      '/ja/guides/link-sharing',
    )
    expect(getPublicPagePath('guides-search', 'en')).toBe('/guides/search')
    expect(getPublicPagePath('guides-search', 'ja')).toBe('/ja/guides/search')
    expect(getPublicPagePath('private-mobile-design-handoff', 'en')).toBe(
      '/guides/private-mobile-design-handoff',
    )
    expect(getPublicPagePath('private-mobile-design-handoff', 'ja')).toBe(
      '/ja/guides/private-mobile-design-handoff',
    )
  })

  test('every configured path resolves to a public route', () => {
    const routes = discoveredRoutes()
    // An index route reports the directory form of its URL ('/ja' → '/ja/').
    const landedOn = (path: string) =>
      resolveRoute(routes, path).resolved?.replace(/(.)\/$/, '$1')

    for (const [id, paths] of Object.entries(pages)) {
      for (const path of Object.values(paths)) {
        expect(landedOn(path), `${id} ${path}`).toBe(path)
      }
    }
  })

  test.each([
    ['missing en', { guide: { ja: '/ja/guide' } }],
    ['missing ja', { guide: { en: '/guide' } }],
    ['en has ja prefix', { guide: { en: '/ja/guide', ja: '/ja/guide-ja' } }],
    ['ja lacks prefix', { guide: { en: '/guide', ja: '/guide-ja' } }],
    ['not root-relative', { guide: { en: 'guide', ja: '/ja/guide' } }],
    [
      'duplicate within locale',
      { one: valid.guide, two: { en: '/guide', ja: '/ja/two' } },
    ],
  ])('%s is rejected', (_name, master) => {
    expect(() => validatePublicPageMaster(master)).toThrow()
  })

  test('accepts the Japanese root path', () => {
    expect(
      validatePublicPageMaster({ landing: { en: '/', ja: '/ja' } }),
    ).toEqual({
      landing: { en: '/', ja: '/ja' },
    })
  })
})
