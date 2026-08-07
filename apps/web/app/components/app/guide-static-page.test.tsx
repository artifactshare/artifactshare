import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
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

  test('renders freshness immediately after a role guide heading', () => {
    const html = renderToStaticMarkup(
      <GuideStaticPage
        html="<h1>Owner guide</h1><p>Body</p>"
        locale="en"
        path="/guides/workspace-owner"
      />,
    )
    expect(html).toContain('Last verified: 2026-07-18')
    expect(html.indexOf('</h1>')).toBeLessThan(html.indexOf('Last verified'))
    expect(html.indexOf('Last verified')).toBeLessThan(html.indexOf('<p>Body'))
  })
})
