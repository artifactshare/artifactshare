import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { page, server } from 'vitest/browser'
import type { ScreenReady } from '~/types/screen'
import { bindI18n } from '~/lib/i18n'
import { PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-prices'
import SettingsLayout from '../_layout'
import { TooltipProvider } from '~/components/ui/tooltip'
import BillingPage, { screen, action as billingAction } from './billing'

declare module 'vitest/browser' {
  interface BrowserCommands {
    waitForScreenReady: (ready: ScreenReady) => Promise<void>
  }
}

vi.mock('~/services/billing.server', () => ({
  isBillingConfigured: () => false,
}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner' }),
}))
const authorize = vi.hoisted(() =>
  vi
    .fn<() => Promise<{ kind: 'ok' | 'forbidden' }>>()
    .mockResolvedValue({ kind: 'ok' }),
)
vi.mock('~/services/team-management.server', () => ({
  requireWorkspaceBillingOwner: authorize,
}))
vi.mock('~/services/project-membership.server', () => ({}))
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
    const ready = setup?.postInteractionReady ?? setup?.ready
    if (!setup || !ready) throw new Error('Missing billing readiness for ' + id)
    const query = setup.query ?? ''
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
    const createBillingRouter = (entry: string) =>
      createMemoryRouter(
        [
          {
            id: 'root',
            path: '/',
            loader: () => ({ locale: 'ja' }),
            element: (
              <TooltipProvider>
                <SettingsLayout
                  loaderData={{
                    kind: 'team',
                    workspace: {
                      id: 'workspace',
                      name: 'Reports',
                      hd: null,
                      plan: 'free',
                      storageUsedBytes: 0,
                      storageQuotaBytes: quota,
                    },
                    currentUserIsAdmin: true,
                    currentUserRole: 'owner',
                    joinedProjects: [],
                    user: {
                      id: 'owner',
                      name: 'Owner',
                      email: 'owner@example.test',
                      image: null,
                      initial: 'O',
                    },
                  }}
                />
              </TooltipProvider>
            ),
            children: [
              {
                path: 'settings/billing',
                element: <BillingPage loaderData={data} />,
                action: ({ request, params }) =>
                  billingAction({
                    request,
                    params,
                    context: new RouterContextProvider(),
                    url: new URL(request.url),
                    pattern: '/settings/billing',
                  }),
              },
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
          initialEntries: [entry],
          hydrationData: { loaderData: { root: { locale: 'ja' } } },
        },
      )
    let router = createBillingRouter('/unconfigured')
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
        await router.navigate(
          '/settings/billing' + query + (query ? '&view=details#usage' : ''),
          { state: { from: 'plans' } },
        )
      })
      expect(container.textContent).toContain(
        bindI18n('ja').t('billing.usage.storageTitle'),
      )
      if (id === 'result-error') {
        await act(async () =>
          router.navigate('/settings/billing?view=purchase'),
        )
        const releases: Array<(result: { kind: 'ok' | 'forbidden' }) => void> =
          []
        const hold = () =>
          new Promise<{ kind: 'ok' | 'forbidden' }>((resolve) =>
            releases.push(resolve),
          )
        authorize.mockImplementationOnce(hold).mockImplementationOnce(hold)
        const plus = page.getByRole('button', {
          name: bindI18n('ja').t('billing.checkout.submit.plus'),
        })
        const team = page.getByRole('button', {
          name: bindI18n('ja').t('billing.checkout.submit.team'),
        })
        await plus.click()
        await team.click()
        await vi.waitFor(() => expect(releases).toHaveLength(2))
        await act(async () => releases[1]({ kind: 'forbidden' }))
        await vi.waitFor(() =>
          expect(
            container.querySelector(
              '[data-plan="team"] form [data-settings-status="forbidden"]',
            ),
          ).not.toBeNull(),
        )
        await expect.element(plus).toBeDisabled()
        await act(async () => releases[0]({ kind: 'ok' }))
        await server.commands.waitForScreenReady(ready)
        authorize.mockImplementationOnce(hold)
        await plus.click()
        await vi.waitFor(() => expect(releases).toHaveLength(3))
        expect(
          container.querySelector('[data-plan="plus"] form [role="alert"]'),
        ).toBeNull()
        await act(async () => releases[2]({ kind: 'ok' }))
      }
      await server.commands.waitForScreenReady(ready)
      if (query)
        expect(router.state.location).toMatchObject({
          search: '?view=details',
          hash: '#usage',
          state: { from: 'plans' },
        })
      container.appendChild(unavailable)
      await expect(
        server.commands.waitForScreenReady({ ...ready, timeoutMs: 100 }),
      ).rejects.toThrow('ready condition was not met: ' + ready.description)
      unavailable.remove()
      if (id === 'result-error') {
        await act(async () => router.navigate(-1))
        expect(router.state.location.search).toBe('')
        expect(container.querySelector('[data-settings-status]')).toBeNull()
        await act(async () => router.navigate(1))
        expect(router.state.location.search).toBe('?view=purchase')
        expect(container.querySelector('[data-settings-status]')).toBeNull()
        await act(async () => router.navigate(-1))
      }
      if (id !== 'near-limit') {
        await act(async () => {
          await router.navigate(-1)
        })
        expect(router.state.location.pathname).toBe('/unconfigured')
        await act(async () => {
          await router.navigate(1)
        })
        expect(router.state.location.pathname).toBe('/settings/billing')
        expect(container.querySelector('[data-settings-status]')).toBeNull()
        if (id === 'result-success') {
          await act(async () => {
            await router.navigate('/settings/billing?status=checkout-success')
          })
          await server.commands.waitForScreenReady(ready)
          await act(async () => {
            await router.navigate('/settings/billing?view=summary')
          })
          expect(container.querySelector('[data-settings-status]')).toBeNull()
          expect(
            container.querySelector('[data-billing-checkout-pending]'),
          ).not.toBeNull()
          await act(async () => {
            await router.navigate(-1)
          })
          expect(container.querySelector('[data-settings-status]')).toBeNull()
          const location = router.state.location
          router.dispose()
          router = createBillingRouter(
            location.pathname + location.search + location.hash,
          )
          await act(async () =>
            root.render(<RouterProvider key="reload" router={router} />),
          )
          expect(container.querySelector('[data-settings-status]')).toBeNull()
          expect(
            container.querySelector('[data-billing-checkout-pending]'),
          ).toBeNull()
          await expect
            .element(
              page.getByRole('button', {
                name: bindI18n('ja').t('billing.checkout.submit.plus'),
              }),
            )
            .toBeVisible()
        }
      }
    } finally {
      await act(async () => root.unmount())
      router.dispose()
      container.remove()
    }
  },
)
