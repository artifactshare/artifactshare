import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
import { expect, test, vi } from 'vitest'
import { server } from 'vitest/browser'
import type { ScreenReady } from '~/types/screen'
import { bindI18n } from '~/lib/i18n'
import BillingPage, { screen } from './billing'

declare module 'vitest/browser' {
  interface BrowserCommands {
    waitForScreenReady: (ready: ScreenReady) => Promise<void>
  }
}

vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))
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
