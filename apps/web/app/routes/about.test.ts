import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'

import { AboutPage, aboutMeta } from './about'

let mockedLocale = 'en' as 'en' | 'ja'
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n(mockedLocale) }
})
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    useFetcher: () => ({ formData: undefined, submit: () => {} }),
    useRouteLoaderData: () => ({ appTheme: 'system' }),
  }
})

describe('/about metadata', () => {
  test.each([
    [
      'en',
      'https://artifactshare.com/about',
      'https://artifactshare.com/ja/about',
    ],
    [
      'ja',
      'https://artifactshare.com/ja/about',
      'https://artifactshare.com/about',
    ],
  ] as const)(
    '%s exposes paired canonical metadata',
    (locale, canonical, enAlternate) => {
      const tags = aboutMeta(locale)
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'canonical',
        href: canonical,
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'en',
        href: 'https://artifactshare.com/about',
      })
      expect(tags).toContainEqual({
        tagName: 'link',
        rel: 'alternate',
        hrefLang: 'ja',
        href: locale === 'ja' ? canonical : enAlternate,
      })
      expect(tags).toContainEqual({
        name: 'twitter:card',
        content: 'summary_large_image',
      })
      expect(tags).toContainEqual({
        property: 'og:image',
        content: 'https://artifactshare.com/og-image',
      })
    },
  )
})

describe('AboutPage', () => {
  test.each([
    ['en', '/connect', '/start', 'Compare plans', 'Official information'],
    ['ja', '/ja/connect', '/ja/start', '料金プランを見る', '公式情報'],
  ] as const)(
    'renders the shared public content in %s',
    (locale, connect, start, pricing, official) => {
      mockedLocale = locale
      const html = renderToStaticMarkup(
        createElement(MemoryRouter, null, createElement(AboutPage, { locale })),
      )

      expect(html).toContain(
        locale === 'ja'
          ? '叩き台が、チームの判断材料になるまで'
          : 'How a draft becomes',
      )
      expect(html).toContain(
        locale === 'ja' ? 'AIでHTMLやMarkdownを作り' : 'teams that use AI',
      )
      for (const step of locale === 'ja'
        ? ['投稿と共有範囲', '該当箇所へのコメント', '同じURLで次の版へ更新']
        : [
            'Publish and choose who can view',
            'Comment at the relevant place',
            'Update to the next version at the same URL',
          ]) {
        expect(html).toContain(step)
      }
      expect(html).toContain(`href="${connect}"`)
      expect(html).toContain(`href="${start}"`)
      expect(html.match(new RegExp(`href="${start}"`, 'g'))).toHaveLength(2)
      expect(html).toContain('<h3')
      expect(html).toContain(`>${pricing}<`)
      expect(html).toContain(`>${official}<`)
      expect(html).toContain('TechTalk, Inc.')
      expect(html).toContain('artifactshare.com')
    },
  )
})
