import { describe, expect, test, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { PricingPage, pricingCheckoutHref, pricingLocaleHref } from './pricing'

vi.mock('~/components/app/public-footer', () => ({
  PublicFooter: ({ variant = 'full' }: { variant?: string }) => (
    <footer data-slot="public-footer" data-variant={variant} />
  ),
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useLocation: () => ({ pathname: '/pricing', search: '', hash: '' }),
  useRouteLoaderData: () => ({ locale: 'en' }),
}))

describe('pricing checkout links', () => {
  test('sends anonymous Free users through sign-in', () => {
    expect(pricingCheckoutHref('free', 'month', 'jpy', false, 'en')).toBe(
      '/sign-in?next=/start',
    )
  })

  test('sends signed-in Free users directly home', () => {
    expect(pricingCheckoutHref('free', 'month', 'jpy', true, 'en')).toBe(
      '/start',
    )
    expect(pricingCheckoutHref('free', 'month', 'jpy', false, 'ja')).toBe(
      '/sign-in?next=/ja/start',
    )
    expect(pricingCheckoutHref('free', 'month', 'jpy', true, 'ja')).toBe(
      '/ja/start',
    )
  })

  test('opens protected paid-plan destinations directly', () => {
    expect(pricingCheckoutHref('plus', 'month', 'jpy', false, 'en')).toBe(
      '/settings/billing?plan=plus&interval=monthly&currency=jpy',
    )
    expect(pricingCheckoutHref('team', 'year', 'usd', true, 'ja')).toBe(
      '/settings/billing?plan=team&interval=yearly&currency=usd',
    )
  })
})

describe('pricing locale links', () => {
  test('links directly between the canonical locale pair', () => {
    expect(pricingLocaleHref('en')).toBe('/pricing')
    expect(pricingLocaleHref('ja')).toBe('/ja/pricing')
  })
})

test('pricing keeps all plan cards, Team recommendation, and checkout links', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PricingPage locale="en" initialCurrency="usd" signedIn />
    </MemoryRouter>,
  )

  expect(html).toContain('data-slot="public-footer" data-variant="full"')
  expect(html).toContain('data-plan="free"')
  expect(html).toContain('data-plan="plus"')
  expect(html).toContain('data-plan="team"')
  expect(html).toContain('Recommended for companies')
  expect(html).toContain(
    'href="/settings/billing?plan=plus&amp;interval=monthly&amp;currency=usd"',
  )
  expect(html).toContain(
    'href="/settings/billing?plan=team&amp;interval=monthly&amp;currency=usd"',
  )
})

test('pricing leaves page-specific navigation to GuideTopbar', () => {
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <PricingPage locale="en" initialCurrency="usd" signedIn={false} />
    </MemoryRouter>,
  )
  const header = html.match(/<header[\s\S]*?<\/header>/)?.[0]

  expect(header).toBeDefined()
  expect(header?.match(/href="\/share-with-ai"/g)).toHaveLength(1)
  expect(header).not.toContain('href="/sign-in"')
})
