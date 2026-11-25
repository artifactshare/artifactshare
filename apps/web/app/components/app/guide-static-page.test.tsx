import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { getPublicGuideVerifiedDate } from '~/lib/public-guide-freshness'
import { GuideStaticPage } from './guide-static-page'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))
vi.mock('~/components/app/guide-shell', () => ({
  GuideTopbar: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
  GuideHomeLink: () => <span />,
  GuideShell: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  GuideProse: ({ children }: { children: ReactNode }) => (
    <article>{children}</article>
  ),
}))
vi.mock('~/components/app/guide-language-switcher', () => ({
  GuideLanguageSwitcher: () => null,
}))
vi.mock('~/components/app/public-footer', () => ({
  PublicFooter: ({ variant = 'full' }: { variant?: string }) => (
    <footer data-slot="public-footer" data-variant={variant} />
  ),
}))

describe('GuideStaticPage', () => {
  test('renders the full public footer', () => {
    const html = renderToStaticMarkup(
      <GuideStaticPage html="<p>Privacy</p>" locale="en" path="/privacy" />,
    )
    expect(html).toContain('data-slot="public-footer" data-variant="full"')
  })

  test.each([
    ['/guides/workspace-owner', 'workspace-owner'],
    ['/guides/workspace-admin', 'workspace-admin'],
    ['/guides/link-sharing', 'link-sharing'],
    ['/guides/search', 'search'],
  ] as const)(
    'renders the %s verified date immediately after its heading',
    (path, guide) => {
      const html = renderToStaticMarkup(
        <GuideStaticPage
          html="<h1>Guide</h1><p>Body</p>"
          locale="en"
          path={path}
        />,
      )
      const verified = html.indexOf(
        `Last verified: ${getPublicGuideVerifiedDate(guide)}`,
      )
      expect(verified).toBeGreaterThan(html.indexOf('</h1>'))
      expect(verified).toBeLessThan(html.indexOf('<p>Body'))
    },
  )

  test.each(['/privacy', '/terms', '/tokushoho'] as const)(
    'renders %s without a verified date',
    (path) => {
      const html = renderToStaticMarkup(
        <GuideStaticPage
          html="<h1>Legal</h1><p>Body</p>"
          locale="en"
          path={path}
        />,
      )
      expect(html).toContain('<p>Body</p>')
      expect(html).not.toContain('Last verified')
    },
  )
})
