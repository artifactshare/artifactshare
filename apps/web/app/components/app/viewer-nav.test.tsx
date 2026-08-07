import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { ViewerNav } from './viewer-nav'

let mockedLocale = 'en' as 'en' | 'ja'
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n(mockedLocale) }
})
vi.mock('~/hooks/use-hydrated', () => ({ useHydrated: () => true }))
vi.mock('~/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  HoverCardContent: ({
    children,
    className,
  }: {
    children: ReactNode
    className?: string
  }) => <div className={className}>{children}</div>,
}))

describe('ViewerNav', () => {
  test.each([
    ['en', 'Artifact Share home', '/about'],
    ['ja', 'Artifact Share のホーム', '/ja/about'],
  ] as const)('renders the About link for %s', (locale, home, aboutHref) => {
    mockedLocale = locale
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/a/demo']}>
        <ViewerNav anonymous />
      </MemoryRouter>,
    )
    expect(html).toContain(`aria-label="${home}"`)
    expect(html).toContain('>About</a>')
    expect(html).toContain('aria-label="About Artifact Share"')
    expect(html).toContain('About Artifact Share')
    expect(html).toContain(`href="${aboutHref}"`)
    expect(html).not.toContain('href="/start"')
    expect(html).not.toContain('href="/ja/start"')
    expect(html).toContain(
      locale === 'ja'
        ? 'HTML ファイルを、社内で安全に共有するサービスです。'
        : 'A service for sharing HTML files safely within your company.',
    )
    expect(html).toContain('href="/"')
    expect(html).toContain('w-[var(--width-product-preview)]')
  })

  test('keeps the signed-in return link alongside the preview', () => {
    mockedLocale = 'en'
    const html = renderToStaticMarkup(
      <MemoryRouter
        initialEntries={[
          { pathname: '/a/demo', state: { galleryReturnTo: '/projects/demo' } },
        ]}
      >
        <ViewerNav />
      </MemoryRouter>,
    )
    expect(html).toContain('href="/projects/demo"')
    expect(html).toContain('aria-label="Back"')
    expect(html).toContain('href="/about"')
    expect(html).toContain('>About</a>')
    expect(html).toContain('href="/"')
  })

  test('renders the About link in the signed-in viewer context', () => {
    mockedLocale = 'en'
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/a/demo']}>
        <ViewerNav />
      </MemoryRouter>,
    )
    expect(html).toContain('>About</a>')
    expect(html).toContain('href="/about"')
    expect(html).toContain('href="/"')
  })

  test('hides the About link on the error variant but keeps home', () => {
    mockedLocale = 'en'
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/a/demo']}>
        <ViewerNav variant="error" />
      </MemoryRouter>,
    )
    expect(html).not.toContain('>About</a>')
    expect(html).not.toContain('href="/about"')
    expect(html).toContain('href="/"')
  })
})
