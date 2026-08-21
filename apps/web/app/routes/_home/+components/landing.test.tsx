import { renderToStaticMarkup } from 'react-dom/server'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import { Landing } from './landing'

const searchParams = vi.hoisted(() => ({ next: null as string | null }))
const rootData = vi.hoisted(() => ({ maintenance: false }))
const mockLocale = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: mockLocale.value,
    t: (key: string) =>
      ({
        'lp.hero.titleDim': 'Share HTML with your team.',
        'lp.hero.titleMain': 'Just tell your AI.',
        'lp.hero.ctaPrimary': 'Share your first file →',
        'lp.hero.ctaSecondary': 'See how to use with AI',
        'lp.hero.cliPrompt': 'Set up with npx --yes @artifactshare/cli init',
        'lp.hero.prompt': 'Share the monthly report to the project with as',
        'lp.hero.shotAlt':
          'An Artifact Share shared page: monthly revenue report',
        'lp.nav.login': 'Log in',
        'lp.nav.start': 'Start for free',
        'lp.ba.q': 'Which one is the latest?',
        'lp.loop.title': 'You comment. AI fixes.',
        'lp.uc.openSample': 'Open a live sample →',
        'lp.quote.attr':
          'Engineering manager, product development team at an e-commerce company',
        'lp.ctaEnd.free': 'The Free plan is free up to 100MB, unlimited users.',
        'lp.maintenanceAuth': 'Artifact Share is under maintenance.',
        'lp.invite.title': 'Sign in to view this file',
        'lp.invite.sub': 'Someone shared a file with you.',
        'lp.invite.about':
          'Share files made with AI, just within your company.',
        'footer.about': 'About Artifact Share',
        'footer.operatedBy': 'Operated by',
        'footer.operatorName': 'TechTalk, Inc.',
        'lp.pricing': 'Pricing',
        'lp.privacy': 'Privacy',
        'lp.terms': 'Terms',
        'lp.tokushoho': 'Commercial Disclosure',
        'signin.email.toggle': 'Sign in with email',
      })[key] ?? key,
  }),
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
  test('renders the marketing landing page with hero, sections, and footer', () => {
    searchParams.next = null
    rootData.maintenance = false
    mockLocale.value = 'en'
    const html = renderLanding()

    expect(html).toContain('Share HTML with your team.')
    expect(html).toContain('Just tell your AI.')
    expect(html).toContain('Share your first file →')
    expect(html).toContain('href="/start"')
    expect(html).toContain('href="/share-with-ai"')
    expect(html).toContain('href="/pricing"')
    expect(html).toContain('href="/sign-in"')
    // First-view language switch to the other locale's page.
    expect(html).toMatch(/<a[^>]*href="\/ja"[^>]*>日本語<\/a>/)
    expect(html).toContain('You comment. AI fixes.')
    expect(html).toContain('Which one is the latest?')
    expect(html).toContain(
      'Engineering manager, product development team at an e-commerce company',
    )
    expect(html).toContain(
      'The Free plan is free up to 100MB, unlimited users.',
    )
    // EN locale gets the EN hero screenshot and EN sample links.
    expect(html).toContain('/landing/hero-share-en.webp')
    expect(html).not.toContain('/landing/hero-share-ja.webp')
    expect(html.match(/Open a live sample →/g)).toHaveLength(4)
    expect(html).toContain('https://artifactshare.com/a/eio7kdav1k')
    expect(html).not.toContain('https://artifactshare.com/a/3kfkaseiki')
    // External sample links never leak referrer or opener.
    expect(html).not.toMatch(
      /href="https:\/\/artifactshare\.com\/a\/[^"]+"(?![^>]*rel="noopener noreferrer")/,
    )
    // The hero prompt renders fully for SSR/no-JS readers.
    expect(html).toContain('Share the monthly report to the project with as')
    expect(html).toContain('data-slot="public-footer" data-variant="full"')
    expect(html).toContain('About Artifact Share')
    expect(html).toContain('TechTalk, Inc.')
    // The old sign-in-on-landing hero is gone.
    expect(html).not.toContain('Sign in to view this file')
    expect(html).not.toContain('lp.ai.summary')
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
    mockLocale.value = 'en'
  })

  test('shows a maintenance banner on the marketing page', () => {
    searchParams.next = null
    rootData.maintenance = true
    const html = renderLanding()

    expect(html).toContain('Artifact Share is under maintenance.')
  })

  test('keeps invite mode focused on sign-in', () => {
    searchParams.next = '/a/demo'
    rootData.maintenance = false
    const html = renderLanding()

    expect(html).toContain('Sign in to view this file')
    expect(html).not.toContain('Share your first file →')
    expect(html).not.toContain('/landing/hero-share-en.webp')
    expect(html).toContain('data-slot="public-footer" data-variant="minimal"')
  })

  test('disables sign-in during maintenance in invite mode', () => {
    searchParams.next = '/a/demo'
    rootData.maintenance = true
    const html = renderLanding()

    expect(html).toContain('Artifact Share is under maintenance.')
    expect(html).toContain('disabled=""')
  })
})
