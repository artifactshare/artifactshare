import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { server } from 'vitest/browser'
import type { ScreenReady } from '~/types/screen'
import { bindI18n } from '~/lib/i18n'
import { PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-prices'
import { StatusBanner } from '../+components/settings-banner'
import BillingPage, { screen } from './billing'

declare module 'vitest/browser' {
  interface BrowserCommands {
    waitForScreenReady: (ready: ScreenReady) => Promise<void>
  }
}

vi.mock('~/services/billing.server', () => ({}))
vi.mock('~/services/billing-usage.server', () => ({}))

test.each(['subscribed', 'past-due', 'continuing-near-limit'])(
  '%s capture requires contract controls without the billing-unavailable notice',
  async (id) => {
    const ready = screen.states.find((state) => state.id === id)?.setup.ready
    if (!ready) throw new Error('Missing billing readiness selector for ' + id)
    const { selector } = ready
    for (const billingConfigured of [true, false]) {
      const data: Parameters<typeof BillingPage>[0]['loaderData'] = {
        canManage: true,
        plan: 'team',
        stripeSubscriptionStatus: id === 'past-due' ? 'past_due' : 'active',
        hasSubscription: true,
        billingConfigured,
        defaultCurrency: 'usd',
        initialPlan: 'team',
        initialInterval: 'monthly',
        storageUsedBytes: 100_000_000_000,
        storageQuotaBytes: 120_000_000_000,
        activeProjectCount: 1,
        projectLimit: null,
        entryContext: 'default',
        externalPostingEnabled: false,
        contract: {
          plan: 'team',
          interval: 'monthly',
          currency: 'usd',
          amount: 20,
          renewsAt: '2030-01-01',
          cancelAtPeriodEnd: false,
        },
        monthlyEstimate: {
          currency: 'usd',
          planAmount: 20,
          overageAmount: 0,
          totalAmount: 20,
          planCharge: 'upcoming',
          cancelAtPeriodEnd: false,
          planDate: '2030-01-01',
          overageGb: 0,
          overageEnabled: true,
        },
        showOverageProjection: true,
        includedBytes: 100 * 1024 ** 3,
        overageProjection: null,
        contributorCount: 1,
      }
      const router = createMemoryRouter([
        {
          path: '/',
          element: <Outlet context={{ currentUserIsAdmin: true }} />,
          children: [
            { index: true, element: <BillingPage loaderData={data} /> },
          ],
        },
      ])
      const container = document.body.appendChild(document.createElement('div'))
      const root = createRoot(container)
      try {
        await act(async () => root.render(<RouterProvider router={router} />))
        expect(document.querySelector(selector) !== null).toBe(
          billingConfigured,
        )
        if (billingConfigured) {
          await server.commands.waitForScreenReady(ready)
          const card = document
            .querySelector(selector)
            ?.closest('[data-slot="card"]')
          const details = card?.querySelector<HTMLElement>(
            '[data-slot="card-description"]',
          )
          if (!details || !card) throw new Error('Missing contract details')
          const controls = card.querySelectorAll<HTMLElement>(
            '[data-slot="card-content"] button',
          )
          expect(controls).toHaveLength(2)
          const cues = [details, ...controls]
          if (id !== 'subscribed') {
            const cue = container.querySelector<HTMLElement>(
              id === 'past-due'
                ? '[data-billing-past-due]'
                : '#billing-estimate-overage',
            )
            if (!cue) throw new Error('Missing billing cue for ' + id)
            cues.push(cue)
          }
          for (const cue of cues) {
            cue.style.visibility = 'hidden'
            await expect(
              server.commands.waitForScreenReady({ ...ready, timeoutMs: 100 }),
            ).rejects.toThrow(
              'ready condition was not met: ' + ready.description,
            )
            cue.style.removeProperty('visibility')
          }
        }
        if (!billingConfigured) {
          const notice = Array.from(container.querySelectorAll('p')).find(
            (p) => p.textContent === bindI18n('en').t('billing.unavailable'),
          )
          if (!notice?.parentElement)
            throw new Error('Missing unavailable notice')
          notice.remove()
          await server.commands.waitForScreenReady(ready)
          container.appendChild(notice)
          expect(document.querySelector(selector)).toBeNull()
          await expect(
            server.commands.waitForScreenReady({ ...ready, timeoutMs: 100 }),
          ).rejects.toThrow('ready condition was not met: ' + ready.description)
        }
      } finally {
        await act(async () => root.unmount())
        router.dispose()
        container.remove()
      }
    }
  },
)

test.each(['result-success', 'result-warning', 'result-error', 'near-limit'])(
  '%s capture is ready with Japanese billing copy',
  async (id) => {
    const setup = screen.states.find((state) => state.id === id)?.setup
    if (!setup?.ready) throw new Error('Missing billing readiness for ' + id)
    const query = setup.query ?? ''
    const status = new URLSearchParams(query).get('status')
    const quota = PLAN_STORAGE_QUOTA_BYTES.free
    const data: Parameters<typeof BillingPage>[0]['loaderData'] = {
      canManage: true,
      plan: 'free',
      stripeSubscriptionStatus: 'none',
      hasSubscription: false,
      billingConfigured: true,
      defaultCurrency: 'jpy',
      initialPlan: 'plus',
      initialInterval: 'monthly',
      storageUsedBytes: id === 'near-limit' ? quota * 0.95 : 0,
      storageQuotaBytes: quota,
      activeProjectCount: 0,
      projectLimit: 5,
      entryContext: 'default',
      externalPostingEnabled: false,
      contract: null,
      monthlyEstimate: null,
      showOverageProjection: false,
      includedBytes: quota,
      overageProjection: null,
      contributorCount: null,
    }
    const router = createMemoryRouter(
      [
        {
          id: 'root',
          path: '/',
          loader: () => ({ locale: 'ja' }),
          element: (
            <>
              {status && <StatusBanner status={status} />}
              <Outlet context={{ currentUserIsAdmin: true }} />
            </>
          ),
          children: [
            { index: true, element: <BillingPage loaderData={data} /> },
            {
              path: 'unconfigured',
              element: (
                <BillingPage
                  loaderData={{ ...data, billingConfigured: false }}
                />
              ),
            },
          ],
        },
      ],
      {
        initialEntries: ['/unconfigured'],
        hydrationData: { loaderData: { root: { locale: 'ja' } } },
      },
    )
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      const unavailable = container.querySelector('[data-billing-unavailable]')
      if (!unavailable) throw new Error('Missing billing-unavailable notice')
      expect(unavailable.textContent).toBe(
        bindI18n('ja').t('billing.unavailable'),
      )
      await act(async () => {
        await router.navigate('/' + query)
      })
      expect(container.textContent).toContain(
        bindI18n('ja').t('billing.usage.storageTitle'),
      )
      await server.commands.waitForScreenReady(setup.ready)
      container.appendChild(unavailable)
      await expect(
        server.commands.waitForScreenReady({ ...setup.ready, timeoutMs: 100 }),
      ).rejects.toThrow(
        'ready condition was not met: ' + setup.ready.description,
      )
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)
