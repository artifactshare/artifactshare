import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { GuideHomeLink, GuideShell, GuideTopbar } from './guide-shell'

let mockedLocale = 'en' as 'en' | 'ja'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: mockedLocale,
    t: (key: string) =>
      ({
        'footer.colProduct': mockedLocale === 'ja' ? 'プロダクト' : 'Product',
        'publicHeader.shareWithAi':
          mockedLocale === 'ja' ? 'AI から使う' : 'Use with AI',
        'publicHeader.pricing': mockedLocale === 'ja' ? '料金' : 'Pricing',
      })[key] ?? key,
  }),
}))

describe('GuideTopbar and GuideHomeLink', () => {
  test.each([
    ['en', '/share-with-ai', '/share-with-ai', 'Use with AI', 'Pricing'],
    ['ja', '/ja/share-with-ai', '/ja/share-with-ai', 'AI から使う', '料金'],
    ['en', '/pricing/', '/pricing', 'Use with AI', 'Pricing'],
    ['ja', '/ja/pricing/', '/ja/pricing', 'AI から使う', '料金'],
  ] as const)(
    'keeps the home link and locale nav contract for %s %s',
    (locale, pathname, activeHref, shareWithAiLabel, pricingLabel) => {
      mockedLocale = locale
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={[pathname]}>
          <GuideTopbar>
            <GuideHomeLink homeLabel="Artifact Share home" />
          </GuideTopbar>
        </MemoryRouter>,
      )

      expect(html).toContain('href="/"')
      expect(html).toContain('aria-label="Artifact Share home"')
      expect(html).toContain('ml-auto')
      expect(html).toContain(
        `aria-label="${locale === 'ja' ? 'プロダクト' : 'Product'}"`,
      )
      expect(html).toContain(
        `href="${locale === 'ja' ? '/ja/share-with-ai' : '/share-with-ai'}"`,
      )
      expect(html).toContain(
        `href="${locale === 'ja' ? '/ja/pricing' : '/pricing'}"`,
      )
      expect(html).toContain(`>${shareWithAiLabel}<`)
      expect(html).toContain(`>${pricingLabel}<`)

      const activeLink = `href="${activeHref}"`
      const activeAnchor = (html.match(/<a[^>]*>/g) ?? []).find((anchor) =>
        anchor.includes(activeLink),
      )
      expect(activeAnchor).toContain('aria-current="page"')
      expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    },
  )

  test('restores the original GuideShell body layout', () => {
    const html = renderToStaticMarkup(
      <GuideShell>
        <div>content</div>
      </GuideShell>,
    )

    expect(html).toContain('gap-16')
    expect(html).not.toContain('justify-between')
    expect(html).not.toContain('gap-4')
  })
})
