import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { MemoryRouter } from 'react-router'
import { AnalyticsConsentBanner } from './analytics-consent-banner'
import { AnalyticsConsentProvider } from './analytics-consent-provider'

let rootData: { analyticsConsent?: { showBanner: boolean } } = {
  analyticsConsent: { showBanner: true },
}
let commentPanelOpen = false
const submit = vi.fn()
let acceptClick: (() => void) | undefined

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) =>
      ({
        'analyticsConsent.banner.aria': 'Analytics consent',
        'analyticsConsent.banner.body': 'Analytics body',
        'analyticsConsent.banner.privacyLink': 'Privacy policy',
        'analyticsConsent.banner.accept': 'Accept',
        'analyticsConsent.banner.decline': 'Decline',
      })[key] ?? key,
  }),
}))

vi.mock('~/components/ui/button', () => ({
  Button: ({
    onClick,
    children,
  }: {
    onClick?: () => void
    children: React.ReactNode
  }) => {
    if (children === 'Accept') acceptClick = onClick
    return <button onClick={onClick}>{children}</button>
  },
}))

vi.mock('./analytics-consent-provider', () => ({
  AnalyticsConsentProvider: ({ children }: { children: React.ReactNode }) =>
    children,
  useAnalyticsConsent: () => ({
    manualOpen: false,
    commentPanelOpen,
    closeBanner: vi.fn(),
    returnFocus: vi.fn(),
  }),
}))

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    useFetcher: () => ({ state: 'idle', data: undefined, submit }),
    useRouteLoaderData: () => rootData,
  }
})

function renderBanner() {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AnalyticsConsentProvider>
        <AnalyticsConsentBanner />
      </AnalyticsConsentProvider>
    </MemoryRouter>,
  )
}

describe('AnalyticsConsentBanner', () => {
  test('renders the consent actions and privacy link', () => {
    rootData = { analyticsConsent: { showBanner: true } }
    const html = renderBanner()
    expect(html).toContain('role="region"')
    expect(html).toContain('aria-label="Analytics consent"')
    expect(html).toContain('>Accept</button>')
    expect(html).toContain('>Decline</button>')
    expect(html).toContain('href="/privacy"')
  })

  test('renders nothing when not requested', () => {
    rootData = { analyticsConsent: { showBanner: false } }
    expect(renderBanner()).toBe('')
  })

  test('hides only while the comment panel is open', () => {
    rootData = { analyticsConsent: { showBanner: true } }
    commentPanelOpen = false
    expect(renderBanner()).not.toContain('max-sheet:hidden')
    commentPanelOpen = true
    expect(renderBanner()).toContain('max-sheet:hidden')
  })

  test('submits granted consent when accepting', () => {
    rootData = { analyticsConsent: { showBanner: true } }
    submit.mockClear()
    acceptClick = undefined
    renderBanner()
    ;(acceptClick as (() => void) | undefined)?.()
    expect(submit).toHaveBeenCalledWith(
      { consent: 'granted' },
      { method: 'POST', action: '/set-analytics-consent' },
    )
  })
})
