import { renderToStaticMarkup } from 'react-dom/server'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { bindI18n, t, type Locale } from '~/lib/i18n'
import { Landing } from './landing'

const searchParams = vi.hoisted(() => ({ next: null as string | null }))
const rootData = vi.hoisted(() => ({ maintenance: false }))
const mockLocale = vi.hoisted(() => ({ value: 'en' as Locale }))

vi.mock('~/hooks/use-t', () => ({
  useT: () => bindI18n(mockLocale.value),
}))

vi.mock('react-router', () => ({
  Link: ({
    children,
    to,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    children: ReactNode
    to: string
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useSearchParams: () => [
    new URLSearchParams(searchParams.next ? { next: searchParams.next } : {}),
  ],
  useRouteLoaderData: () => rootData,
  useLocation: () => ({ pathname: '/', search: '', hash: '' }),
  useFetcher: () => ({ formData: undefined, submit: () => {} }),
}))

vi.mock('~/components/app/google-mark', () => ({
  GoogleMark: () => <span>Google</span>,
}))

vi.mock('~/components/app/microsoft-mark', () => ({
  MicrosoftMark: () => <span>Microsoft</span>,
}))

vi.mock('~/lib/auth-client', () => ({
  signIn: { social: vi.fn() },
}))

function renderLanding() {
  return renderToStaticMarkup(
    <TooltipProvider>
      <Landing />
    </TooltipProvider>,
  )
}

describe('Landing', () => {
  afterEach(() => {
    mockLocale.value = 'en'
  })

  test('renders the marketing landing page with hero, sections, and footer', () => {
    searchParams.next = null
    rootData.maintenance = false
    mockLocale.value = 'en'
    const html = renderLanding()

    expect(html).toContain(t('en', 'lp.hero.titleDim'))
    expect(html).toContain(t('en', 'lp.hero.titleMain'))
    expect(html).toContain(t('en', 'lp.hero.ctaPrimary'))
    expect(html).toContain('href="/start"')
    expect(html).toContain('href="/share-with-ai"')
    expect(html).toContain('href="/pricing"')
    expect(html).toContain('href="/sign-in"')
    // First-view language switch to the other locale's page.
    expect(html).toMatch(/<a[^>]*href="\/ja"[^>]*>日本語<\/a>/)
    expect(html).toContain(t('en', 'lp.loop.title'))
    expect(html).toContain(t('en', 'lp.ba.q'))
    expect(html).toContain(t('en', 'lp.quote.attr'))
    expect(html).toContain(t('en', 'lp.ctaEnd.free'))
    // EN locale gets the EN hero screenshot and EN sample links.
    expect(html).toContain('/landing/hero-share-en.webp')
    expect(html).not.toContain('/landing/hero-share-ja.webp')
    expect(html.split(t('en', 'lp.uc.openSample')).length - 1).toBe(4)
    expect(html).toContain('https://artifactshare.com/a/eio7kdav1k')
    expect(html).not.toContain('https://artifactshare.com/a/3kfkaseiki')
    // External sample links never leak referrer or opener.
    expect(html).not.toMatch(
      /href="https:\/\/artifactshare\.com\/a\/[^"]+"(?![^>]*rel="noopener noreferrer")/,
    )
    // The hero prompt renders fully for SSR/no-JS readers.
    expect(html).toContain(t('en', 'lp.hero.prompt'))
    expect(html).toContain('data-slot="public-footer" data-variant="full"')
    expect(html).toContain(t('en', 'footer.about'))
    expect(html).toContain(t('en', 'footer.operatorName'))
    // The old sign-in-on-landing hero is gone.
    expect(html).not.toContain(t('en', 'lp.invite.title'))
    // A key reaching the markup means the catalog has no copy for it.
    expect(html).not.toMatch(/\b(?:lp|signin|footer)\.[a-zA-Z]/)
  })

  test('renders the Japanese landing with ja assets, links, and switch', () => {
    searchParams.next = null
    rootData.maintenance = false
    mockLocale.value = 'ja'
    const html = renderLanding()

    expect(html).toContain('/landing/hero-share-ja.webp')
    expect(html).not.toContain('/landing/hero-share-en.webp')
    expect(html).toContain('https://artifactshare.com/a/3kfkaseiki')
    expect(html).not.toContain('https://artifactshare.com/a/eio7kdav1k')
    expect(html).toContain('href="/ja/pricing"')
    expect(html).toContain('href="/ja/start"')
    // First-view switch back to the English page.
    expect(html).toMatch(/<a[^>]*href="\/"[^>]*>English<\/a>/)
  })

  test('shows a maintenance banner on the marketing page', () => {
    searchParams.next = null
    rootData.maintenance = true
    const html = renderLanding()

    expect(html).toContain(t('en', 'lp.maintenanceAuth'))
  })

  test('keeps invite mode focused on sign-in', () => {
    searchParams.next = '/a/demo'
    rootData.maintenance = false
    const html = renderLanding()

    expect(html).toContain(t('en', 'lp.invite.title'))
    expect(html).not.toContain(t('en', 'lp.hero.ctaPrimary'))
    expect(html).not.toContain('/landing/hero-share-en.webp')
    expect(html).toContain('data-slot="public-footer" data-variant="minimal"')
  })

  test('shows the focused sign-in view for protected-route redirects', () => {
    searchParams.next = '/settings/plan'
    rootData.maintenance = false
    const html = renderLanding()

    expect(html).toContain(t('en', 'signin.sub'))
    expect(html).not.toContain(t('en', 'lp.invite.title'))
    expect(html).not.toContain(t('en', 'lp.hero.ctaPrimary'))
  })

  test('disables sign-in during maintenance in invite mode', () => {
    searchParams.next = '/a/demo'
    rootData.maintenance = true
    const html = renderLanding()

    expect(html).toContain(t('en', 'lp.maintenanceAuth'))
    expect(html).toContain('disabled=""')
  })
})
