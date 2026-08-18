import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { PublicFooter } from './public-footer'

let mockedLocale = 'en' as 'en' | 'ja'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: mockedLocale,
    t: (key: string) =>
      ({
        'lp.privacy': 'Privacy',
        'lp.terms': 'Terms',
        'lp.tokushoho': 'Commercial Disclosure',
        'lp.pricing': 'Pricing',
        'footer.connect': 'Connect',
        'footer.shareWithAi': 'Share with AI',
        'footer.about': 'About Artifact Share',
        'footer.operatedBy': 'Operated by',
        'footer.operatorName': 'TechTalk, Inc.',
        'updates.pageTitle': 'Updates',
        'lp.invite.about': 'About Artifact Share',
        'footer.colProduct': 'Product',
        'footer.colLegal': 'Legal',
      })[key] ?? key,
  }),
}))

vi.mock('~/components/app/brand-mark', () => ({ BrandMark: () => <span /> }))

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    useFetcher: () => ({ formData: undefined, submit: vi.fn() }),
    useRouteLoaderData: () => ({ appTheme: 'system' }),
  }
})

describe('PublicFooter', () => {
  test.each([
    ['en', '/privacy'],
    ['ja', '/ja/privacy'],
  ] as const)('renders complete locale links for %s', (locale, privacyHref) => {
    mockedLocale = locale
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PublicFooter />
      </MemoryRouter>,
    )
    expect(html).toContain('data-slot="public-footer" data-variant="full"')
    expect(html).toContain(`href="${privacyHref}"`)
    for (const href of [
      '/connect',
      '/share-with-ai',
      '/pricing',
      '/updates',
      '/terms',
      '/tokushoho',
    ]) {
      expect(html).toContain(`href="${locale === 'ja' ? `/ja${href}` : href}"`)
    }
    expect(html).toContain(`© ${new Date().getFullYear()} Artifact Share`)
    expect(html).toContain(`href="${locale === 'ja' ? '/ja/about' : '/about'}"`)
    expect(html).toContain('About Artifact Share')
    expect(html).toContain('Operated by')
    expect(html).toContain('TechTalk, Inc.')
    expect(html).toContain('href="https://www.techtalk.jp"')
    expect(html).toContain(
      'href="https://github.com/artifactshare/artifactshare"',
    )
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer"')
    expect(html).toMatch(/<a[^>]*aria-label="[^"]*"[^>]*href="\/"/)
  })

  test('minimal renders only legal links and copyright', () => {
    mockedLocale = 'en'
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <PublicFooter variant="minimal" />
      </MemoryRouter>,
    )
    expect(html).toContain('data-slot="public-footer" data-variant="minimal"')
    expect(html).not.toContain('href="/connect"')
    expect(html).not.toContain('href="/about"')
    expect(html).not.toContain(
      'href="https://github.com/artifactshare/artifactshare"',
    )
    expect(html).not.toContain('Operated by TechTalk, Inc.')
    for (const href of ['/privacy', '/terms', '/tokushoho'])
      expect(html).toContain(`href="${href}"`)
    expect(html).toContain(`© ${new Date().getFullYear()} Artifact Share`)
    expect(html).not.toContain('aria-label="Language"')
    expect(html).not.toContain('href="/ja"')
  })

  test.each([
    ['/', 'en', '/ja', 'English'],
    ['/ja', 'ja', '/', '日本語'],
  ] as const)(
    '%s full footer links to the other locale',
    (path, locale, otherHref, currentLabel) => {
      mockedLocale = locale
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={[path]}>
          <PublicFooter />
        </MemoryRouter>,
      )

      expect(html).toContain(`href="${otherHref}"`)
      expect(html).toContain(`aria-current="true">${currentLabel}</span>`)
    },
  )

  test('preserves query and hash when switching locale on a landing page', () => {
    mockedLocale = 'en'
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/?utm_source=test#pricing']}>
        <PublicFooter />
      </MemoryRouter>,
    )

    expect(html).toContain('href="/ja?utm_source=test#pricing"')
  })
})
