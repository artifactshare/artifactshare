import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { ViewerNav } from './viewer-nav'

let mockedLocale = 'en' as 'en' | 'ja'
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n(mockedLocale) }
})
vi.mock('~/hooks/use-hydrated', () => ({ useHydrated: () => true }))

describe('ViewerNav', () => {
  test.each([
    ['en', 'Artifact Share home', '/'],
    ['ja', 'Artifact Share のホーム', '/ja'],
  ] as const)(
    'links anonymous %s viewers to the localized public home without an About replacement',
    (locale, home, homeHref) => {
      mockedLocale = locale
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/a/demo']}>
          <ViewerNav anonymous />
        </MemoryRouter>,
      )
      expect(html).toContain(`aria-label="${home}"`)
      expect(html).toContain(`href="${homeHref}"`)
      expect(html).not.toContain('>About</a>')
      expect(html).not.toContain('href="/about"')
      expect(html).not.toContain('href="/ja/about"')
      expect(html).not.toContain('Share yours')
      expect(html).not.toContain('自分も共有')
    },
  )

  test('keeps the signed-in return link without an About replacement', () => {
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
    expect(html).toContain('href="/"')
    expect(html).not.toContain('>About</a>')
    expect(html).not.toContain('href="/about"')
  })

  test.each(['en', 'ja'] as const)(
    'keeps the signed-in %s viewer logo linked to app home',
    (locale) => {
      mockedLocale = locale
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={['/a/demo']}>
          <ViewerNav />
        </MemoryRouter>,
      )
      expect(html).toContain('href="/"')
      expect(html).not.toContain('>About</a>')
      expect(html).not.toContain('href="/about"')
      expect(html).not.toContain('href="/ja/about"')
    },
  )

  test('keeps the error variant linked home without About', () => {
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
