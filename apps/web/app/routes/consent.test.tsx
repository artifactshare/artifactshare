// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import Consent, { consentInfoFrom } from './consent'
import { oauthClientInfo, oauthConsent } from '~/lib/auth-client'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ t: (key: string) => key }),
}))
vi.mock('react-router', () => ({
  useSearchParams: () => [consentParams],
}))
vi.mock('~/lib/auth-client', () => ({
  oauthClientInfo: vi.fn(),
  oauthConsent: vi.fn(),
}))
vi.mock('~/components/app/focused-flow-brand', () => ({
  FocusedFlowBrand: () => <a href="/">Artifact Share</a>,
}))
vi.mock('~/components/app/landing-shell', () => ({
  LandingHero: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  LandingShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock('~/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}))

let consentParams = new URLSearchParams()
const oauthClientInfoMock = vi.mocked(oauthClientInfo)
const oauthConsentMock = vi.mocked(oauthConsent)
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('/consent', () => {
  beforeEach(() => {
    consentParams = new URLSearchParams('client_id=client&scope=openid')
    oauthClientInfoMock.mockReset()
    oauthConsentMock.mockReset()
    document.body.innerHTML = ''
  })

  test('uses the client name and scopes from the consent URL', () => {
    expect(
      consentInfoFrom({ data: { client_name: 'Example app' } }, [
        'openid',
        'profile',
      ]),
    ).toEqual({
      kind: 'ready',
      name: 'Example app',
      scopes: ['openid', 'profile'],
    })
  })

  test('falls back to trusted client metadata when client_name is empty', () => {
    expect(
      consentInfoFrom({ data: { client_uri: 'https://client.example/app' } }, [
        'openid',
      ]),
    ).toEqual({
      kind: 'ready',
      name: 'client.example',
      scopes: ['openid'],
    })
  })

  test.each([
    [{ data: {} }, ['openid', 'profile']],
    [{ data: { client_name: 'Example app' } }, []],
    [{ data: { client_name: null } }, ['openid']],
    [{ data: [] }, ['openid']],
    [null, ['openid']],
    [{ error: { status: 500 } }, ['openid']],
  ])('fails closed when consent details are incomplete: %s', (res, scopes) => {
    expect(consentInfoFrom(res, scopes)).toEqual({ kind: 'unavailable' })
  })

  test('renders the flow title as the page heading', () => {
    const html = renderToStaticMarkup(<Consent />)

    expect(html).toContain('<h1')
    expect(html).toContain('oa.consent.title</h1>')
  })

  test('keeps loading non-interactive until client info is ready', async () => {
    let resolveInfo!: (value: unknown) => void
    oauthClientInfoMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInfo = resolve
      }),
    )
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () => root.render(<Consent />))
    expect(container.querySelector('button')).toBeNull()
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'oa.consent.loading',
    )

    await React.act(async () => {
      resolveInfo({ data: { client_name: 'Example app' } })
    })
    expect(container.querySelector('button')?.textContent).toBe(
      'oa.consent.allow',
    )
    await React.act(async () => root.unmount())
  })

  test.each([
    [
      { data: { client_uri: 'https://trusted.example/app' } },
      'trusted.example',
    ],
    [
      { data: { client_name: '', client_id: 'server-client' } },
      'server-client',
    ],
    [
      {
        data: {
          client_name: '   ',
          client_uri: 'not a URL',
          client_id: 'server-client',
        },
      },
      'server-client',
    ],
  ])(
    'keeps Allow and displays a safe fallback when client_name is missing or empty: %s',
    async (response, displayName) => {
      consentParams = new URLSearchParams(
        'client_id=client&scope=openid&redirect_uri=https%3A%2F%2Fspoofed.example%2Fcallback',
      )
      oauthClientInfoMock.mockResolvedValue(response)
      const container = document.createElement('div')
      const root = createRoot(container)

      await React.act(async () => root.render(<Consent />))

      expect(container.textContent).toContain(displayName)
      expect(container.textContent).not.toContain('spoofed.example')
      expect(container.querySelector('button')?.textContent).toBe(
        'oa.consent.allow',
      )
      await React.act(async () => root.unmount())
    },
  )

  test('resets to loading when consent parameters change', async () => {
    let resolveInfo!: (value: unknown) => void
    oauthClientInfoMock.mockResolvedValue({
      data: { client_name: 'Example app' },
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    await React.act(async () => root.render(<Consent />))
    expect(container.querySelector('button')?.textContent).toBe(
      'oa.consent.allow',
    )

    oauthClientInfoMock.mockReturnValue(
      new Promise((resolve) => {
        resolveInfo = resolve
      }),
    )
    await React.act(async () => {
      consentParams = new URLSearchParams('client_id=other&scope=profile')
      root.render(<Consent />)
    })
    expect(container.querySelector('button')).toBeNull()
    resolveInfo({ data: { client_name: 'Other app' } })
    await React.act(async () => {})
    await React.act(async () => root.unmount())
  })

  test('shows fail-closed Close after unavailable result', async () => {
    oauthClientInfoMock.mockRejectedValue(new Error('missing'))
    oauthConsentMock.mockResolvedValue({ data: {} })
    const container = document.createElement('div')
    const root = createRoot(container)
    await React.act(async () => root.render(<Consent />))
    const close = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'oa.consent.close',
    )
    expect(close).toBeDefined()
    expect(container.textContent).not.toContain('oa.consent.allow')
    await React.act(async () => close?.click())
    expect(oauthConsentMock).toHaveBeenCalledWith(false)
    await React.act(async () => root.unmount())
  })

  test('shows fail-closed Close after malformed client info', async () => {
    oauthClientInfoMock.mockResolvedValue({ data: [] })
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () => root.render(<Consent />))

    expect(container.querySelector('button')?.textContent).not.toBe(
      'oa.consent.allow',
    )
    expect(container.textContent).toContain('oa.consent.close')
    await React.act(async () => root.unmount())
  })

  test('ignores an old consent failure after the request changes', async () => {
    oauthClientInfoMock.mockResolvedValue({
      data: { client_name: 'Example app' },
    })
    let rejectConsent!: (reason?: unknown) => void
    oauthConsentMock.mockReturnValue(
      new Promise((_, reject) => {
        rejectConsent = reject
      }),
    )
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () => root.render(<Consent />))
    await React.act(async () => container.querySelector('button')?.click())
    consentParams = new URLSearchParams('client_id=other&scope=profile')
    oauthClientInfoMock.mockResolvedValue({
      data: { client_name: 'Other app' },
    })
    await React.act(async () => root.render(<Consent />))
    rejectConsent(new Error('old request failed'))
    await React.act(async () => {})

    expect(container.textContent).not.toContain('oa.consent.error')
    await React.act(async () => root.unmount())
  })

  test('does not redirect from an old consent success after the request changes', async () => {
    oauthClientInfoMock.mockResolvedValue({
      data: { client_name: 'Example app' },
    })
    let resolveConsent!: (value: unknown) => void
    oauthConsentMock.mockReturnValue(
      new Promise((resolve) => {
        resolveConsent = resolve
      }),
    )
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () => root.render(<Consent />))
    const originalHref = window.location.href
    await React.act(async () => container.querySelector('button')?.click())
    consentParams = new URLSearchParams(
      'client_id=client&scope=openid&state=new-state',
    )
    oauthClientInfoMock.mockResolvedValue({
      data: { client_name: 'Other app' },
    })
    await React.act(async () => root.render(<Consent />))
    resolveConsent({ data: { url: 'https://old.example/callback' } })
    await React.act(async () => {})

    expect(window.location.href).toBe(originalHref)
    expect(container.textContent).not.toContain('oa.consent.error')
    await React.act(async () => root.unmount())
  })

  test('ignores an old decision failure when only consent query identity changes', async () => {
    oauthClientInfoMock.mockResolvedValue({
      data: { client_name: 'Example app' },
    })
    let rejectConsent!: (reason?: unknown) => void
    oauthConsentMock.mockReturnValue(
      new Promise((_, reject) => {
        rejectConsent = reject
      }),
    )
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () => root.render(<Consent />))
    await React.act(async () => container.querySelector('button')?.click())
    consentParams = new URLSearchParams(
      'scope=openid&state=new-state&client_id=client',
    )
    await React.act(async () => root.render(<Consent />))
    rejectConsent(new Error('old request failed'))
    await React.act(async () => {})

    expect(container.textContent).not.toContain('oa.consent.error')
    await React.act(async () => root.unmount())
  })
})
