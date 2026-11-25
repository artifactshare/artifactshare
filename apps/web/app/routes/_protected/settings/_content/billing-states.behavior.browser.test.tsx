import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  Outlet,
  RouterContextProvider,
  RouterProvider,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { bindI18n } from '~/lib/i18n'
import { formatBytes } from '~/lib/format'
import { PLAN_DISPLAY, PLAN_STORAGE_QUOTA_BYTES } from '~/lib/billing-prices'
import SettingsLayout from '../_layout'
import { TooltipProvider } from '~/components/ui/tooltip'
import BillingPage, { action as billingAction } from './billing'

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

// Waits until every selector matches an element the user can see.
async function expectVisible(...selectors: string[]) {
  for (const selector of selectors)
    await vi.waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLElement>(selector)].some((element) =>
          element.checkVisibility({ visibilityProperty: true }),
        ),
      ).toBe(true),
    )
}

const WORKSPACE_STORAGE_USED_BYTES = 100_000_000_000

// Only the confirmation dialog shows the downgrade impact, so SSR cannot see
// whether the page hands it this workspace's usage or a placeholder.
async function expectDowngradeNamesWorkspaceStorage() {
  const en = bindI18n('en')
  await page
    .getByRole('button', { name: en.t('billing.change.plan.downgrade') })
    .click()
  const impact = page.getByRole('alert').filter({
    hasText: en.t('billing.downgrade.overStorage', {
      used: formatBytes(WORKSPACE_STORAGE_USED_BYTES),
      limit: PLAN_DISPLAY.plus.storage,
    }),
  })
  await expect.element(impact).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await vi.waitFor(() => expect(impact.query()).toBeNull())
}

const plans = ['[data-plan="team"]', '[data-plan="plus"]']
const outcomes = {
  'result-success': {
    query: '?status=checkout-success',
    visible: [
      '[data-billing-checkout-pending]',
      '[role="status"][data-settings-status="checkout-success"]',
    ],
  },
  'result-warning': {
    query: '?status=checkout-cancelled',
    visible: [
      ...plans,
      '[role="status"][data-settings-status="checkout-cancelled"]',
    ],
  },
  'result-error': {
    query: '',
    visible: [
      ...plans,
      '[data-plan="plus"] form [role="alert"][data-settings-status="billing-unavailable"]',
    ],
  },
  'near-limit': {
    query: '',
    visible: [...plans, '[role="alert"] [data-billing-upgrade-guidance]'],
  },
}

test.each(['subscribed', 'past-due', 'continuing-near-limit'])(
  '%s shows its contract controls and billing availability',
  async (id) => {
    const selector = 'form:has(input[value="portal"]) button:enabled'
    for (const billingConfigured of [true, false]) {
      const data: Parameters<typeof BillingPage>[0]['loaderData'] = {
        canManage: true,
        stripeSubscriptionStatus: id === 'past-due' ? 'past_due' : 'active',
        hasSubscription: true,
        billingConfigured,
        defaultCurrency: 'usd',
        initialPlan: 'team',
        initialInterval: 'monthly',
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
          element: (
            <Outlet
              context={{
                currentUserIsAdmin: true,
                workspace: {
                  plan: 'team',
                  storageUsedBytes: WORKSPACE_STORAGE_USED_BYTES,
                  storageQuotaBytes: 120_000_000_000,
                },
              }}
            />
          ),
          children: [
            { index: true, element: <BillingPage loaderData={data} /> },
          ],
        },
        { path: '/settings/billing-preview', loader: () => null },
      ])
      const container = document.body.appendChild(document.createElement('div'))
      const root = createRoot(container)
      try {
        await act(async () => root.render(<RouterProvider router={router} />))
        if (billingConfigured) {
          const cues = [
            '[data-billing-contract-details]',
            '[data-billing-change="plan"]',
            '[data-billing-change="interval"]',
          ]
          if (id === 'continuing-near-limit')
            cues.push('#billing-estimate-overage')
          await expectVisible(selector, ...cues)
          if (id === 'past-due')
            await expect
              .element(
                page.getByRole('alert').filter({
                  hasText: bindI18n('en').t('billing.pastDue.banner'),
                }),
              )
              .toBeVisible()
          const card = document
            .querySelector(selector)
            ?.closest('[data-slot="card"]')
          const details = card?.querySelector<HTMLElement>(
            '[data-slot="card-description"]',
          )
          if (!details || !card) throw new Error('Missing contract details')
          expect(
            card.querySelectorAll<HTMLElement>(
              '[data-slot="card-content"] button',
            ),
          ).toHaveLength(2)
          expect(
            container.querySelector('[data-billing-unavailable]'),
          ).toBeNull()
          if (id === 'subscribed') await expectDowngradeNamesWorkspaceStorage()
        } else {
          expect(
            Array.from(container.querySelectorAll('p')).some(
              (p) => p.textContent === bindI18n('en').t('billing.unavailable'),
            ),
          ).toBe(true)
        }
      } finally {
        await act(async () => root.unmount())
        router.dispose()
        container.remove()
      }
    }
  },
)

test.each(Object.keys(outcomes) as Array<keyof typeof outcomes>)(
  '%s shows its billing outcome with Japanese billing copy',
  async (id) => {
    const { query, visible } = outcomes[id]
    const quota = PLAN_STORAGE_QUOTA_BYTES.free
    const data: Parameters<typeof BillingPage>[0]['loaderData'] = {
      canManage: true,
      stripeSubscriptionStatus: 'none',
      hasSubscription: false,
      billingConfigured: true,
      defaultCurrency: 'jpy',
      initialPlan: 'plus',
      initialInterval: 'monthly',
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
                      storageUsedBytes: id === 'near-limit' ? quota * 0.95 : 0,
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
        await expectVisible(...visible)
        authorize.mockImplementationOnce(hold)
        await plus.click()
        await vi.waitFor(() => expect(releases).toHaveLength(3))
        // The new submission replaces the earlier failure once React renders
        // the submitting state, which a busy runner can commit after the call.
        await expect.element(plus).toBeDisabled()
        expect(
          container.querySelector('[data-plan="plus"] form [role="alert"]'),
        ).toBeNull()
        await act(async () => releases[2]({ kind: 'ok' }))
      }
      await expectVisible(...visible)
      expect(container.querySelector('[data-billing-unavailable]')).toBeNull()
      if (id === 'result-success')
        expect(container.querySelector('[data-plan]')).toBeNull()
      if (query)
        expect(router.state.location).toMatchObject({
          search: '?view=details',
          hash: '#usage',
          state: { from: 'plans' },
        })
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
          await expectVisible(...visible)
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
