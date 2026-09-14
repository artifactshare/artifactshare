import { describe, expect, test } from 'vitest'

import pages from '~/public-pages.json'

import { getPublicPagePath, validatePublicPageMaster } from './public-pages'

const valid = { guide: { en: '/guide', ja: '/ja/guide' } }
const routeModules = import.meta.glob([
  '../routes/_public/($locale)/_home/index.tsx',
  '../routes/**/*.tsx',
  '!../routes/**/*.test.tsx',
])

const LOCALE_ROUTE_NAMES = new Set([
  'about',
  'connect',
  'share-with-ai',
  'pricing',
  'privacy',
  'start',
  'terms',
  'tokushoho',
])

function routeModuleFor(path: string): string {
  const localePath = path.replace(/^\/ja\//, '/').slice(1)
  if (LOCALE_ROUTE_NAMES.has(localePath) || localePath.startsWith('guides/')) {
    return `../routes/_public/($locale)/${localePath.replaceAll('/', '.')}.tsx`
  }
  if (/^\/(?:ja\/)?updates$/u.test(path)) {
    return '../routes/_public/($locale)/updates.tsx'
  }
  return path === '/' || path === '/ja'
    ? '../routes/_public/($locale)/_home/index.tsx'
    : `../routes/${path.slice(1).replaceAll('/', '.')}.tsx`
}

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
    expect(getPublicPagePath('private-mobile-design-handoff', 'en')).toBe(
      '/guides/private-mobile-design-handoff',
    )
    expect(getPublicPagePath('private-mobile-design-handoff', 'ja')).toBe(
      '/ja/guides/private-mobile-design-handoff',
    )
  })

  test('every configured path has a static route module', () => {
    for (const paths of Object.values(pages)) {
      for (const path of Object.values(paths)) {
        const routeModule = routeModuleFor(path)
        expect(routeModules, `${path} must have ${routeModule}`).toHaveProperty(
          routeModule,
        )
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
