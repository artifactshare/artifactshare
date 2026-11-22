import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  RouterProvider,
  useFetcher,
  useRouteError,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { page, userEvent, server } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import SettingsLayout from '../_layout'
import SettingsContent, { ErrorBoundary } from './_layout'
import GeneralPage, { screen } from './general'
import BillingPage from './billing'

vi.mock('~/services/team-management.server', () => ({}))
vi.mock('~/services/project-membership.server', () => ({}))
vi.mock('~/services/dev-screen-state.server', () => ({}))
vi.mock('~/services/billing.server', () => ({}))
vi.mock('~/services/billing-usage.server', () => ({}))
vi.mock('~/services/db.server', () => ({}))
vi.mock('~/middleware/context', () => ({}))

function Submission() {
  const fetcher = useFetcher<{ result: string }>()
  return (
    <fetcher.Form method="post">
      <button type="submit">Submit</button>
      <p>{fetcher.data?.result}</p>
    </fetcher.Form>
  )
}

test.each(['loader', 'action', 'preview'])(
  'retains the Settings shell after a thrown %s and recovers',
  async (fault) => {
    await page.viewport(fault === 'loader' ? 390 : 1440, 844)
    let shouldThrow = false
    const preview = vi.fn(() => {
      if (shouldThrow) throw new Error('preview failed')
      return {
        kind: 'ok',
        currency: 'usd',
        prorationAmount: 5,
        nextInvoiceAt: null,
      }
    })
    const router = createMemoryRouter(
      [
        {
          id: 'root',
          path: 'settings',
          errorElement: (
            <div data-screen-capture-error="route-error-boundary" />
          ),
          element: (
            <TooltipProvider>
              <SettingsLayout
                loaderData={{
                  kind: 'team',
                  workspace: {
                    id: 'ws',
                    name: 'Example workspace',
                    hd: null,
                    plan: 'team',
                    storageUsedBytes: 0,
                    storageQuotaBytes: 100,
                  },
                  currentUserIsAdmin: true,
                  currentUserRole: 'owner',
                  user: {
                    id: 'owner',
                    email: 'owner@example.test',
                    name: 'Owner',
                    initial: 'O',
                    image: null,
                  },
                  joinedProjects: [],
                }}
              />
            </TooltipProvider>
          ),
          children: [
            { path: 'billing-preview', loader: preview },
            {
              element: <SettingsContent />,
              ErrorBoundary: () => <ErrorBoundary error={useRouteError()} />,
              children: [
                {
                  index: true,
                  element: <GeneralPage loaderData={{ owner: null }} />,
                },
                {
                  path: 'general',
                  loader: () => {
                    throw new Error('loader failed')
                  },
                  element: <GeneralPage loaderData={{ owner: null }} />,
                },
                {
                  path: 'submit',
                  Component: Submission,
                  action: () => {
                    if (shouldThrow) throw new Error('action failed')
                    return { result: 'Validation failed' }
                  },
                },
                {
                  path: 'billing',
                  element: (
                    <BillingPage
                      loaderData={{
                        showOverageProjection: false,
                        includedBytes: 100,
                        overageProjection: null,
                        contributorCount: null,
                        contract: {
                          plan: 'team',
                          interval: 'monthly',
                          currency: 'usd',
                          amount: 20,
                          renewsAt: null,
                          cancelAtPeriodEnd: false,
                        },
                        canManage: true,
                        plan: 'team',
                        stripeSubscriptionStatus: 'active',
                        hasSubscription: true,
                        billingConfigured: true,
                        defaultCurrency: 'usd',
                        initialPlan: 'team',
                        initialInterval: 'monthly',
                        storageUsedBytes: 0,
                        storageQuotaBytes: 100,
                        activeProjectCount: 1,
                        projectLimit: null,
                        entryContext: 'default',
                        externalPostingEnabled: true,
                        monthlyEstimate: null,
                      }}
                    />
                  ),
                },
              ],
            },
          ],
        },
      ],
      { initialEntries: ['/settings'] },
    )
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      await expect
        .element(page.getByRole('textbox'))
        .toHaveValue('Example workspace')
      if (fault === 'loader')
        await act(() => router.navigate('/settings/general'))
      if (fault === 'action') {
        await act(() => router.navigate('/settings/submit'))
        await page.getByRole('button', { name: 'Submit' }).click()
        await expect.element(page.getByText('Validation failed')).toBeVisible()
        shouldThrow = true
        await page.getByRole('button', { name: 'Submit' }).click()
      }
      if (fault === 'preview') {
        await act(() => router.navigate('/settings/billing'))
        const change = page.elementLocator(
          document.querySelector('[data-billing-change="interval"]')!,
        )
        await change.click()
        await expect.element(page.getByRole('alertdialog')).toBeVisible()
        await expect
          .element(page.getByText(/Prorated adjustment for this change/))
          .toBeVisible()
        expect(preview).toHaveBeenCalledOnce()
        await page.getByRole('button', { name: 'Cancel', exact: true }).click()
        shouldThrow = true
        await change.click()
      }
      const back = page.getByRole('link', { name: 'Back to settings' })
      await expect.element(back).toBeVisible()
      expect(
        container.querySelector(
          '[data-screen-capture-error="settings-error-boundary"]',
        ),
      ).not.toBeNull()
      expect(
        container.querySelector(
          '[data-screen-capture-error="route-error-boundary"]',
        ),
      ).toBeNull()
      const ready = screen.states.find(
        (state) => state.id === 'unexpected-error',
      )?.setup.ready
      if (!ready) throw new Error('Missing Settings error readiness')
      await server.commands.waitForScreenReady(ready)
      if (fault === 'loader') {
        await expect
          .element(
            page.elementLocator(
              container.querySelector('[data-bottom-tab-bar]')!,
            ),
          )
          .toBeVisible()
        await page
          .elementLocator(
            container.querySelector('main button[data-slot="sheet-trigger"]')!,
          )
          .click()
        await expect
          .element(
            page
              .getByRole('dialog')
              .getByRole('navigation', { name: 'Workspace settings' }),
          )
          .toBeVisible()
        await userEvent.keyboard('{Escape}')
      } else {
        await expect
          .element(page.getByRole('navigation', { name: 'Workspace settings' }))
          .toBeVisible()
      }
      if (fault === 'preview') expect(preview).toHaveBeenCalledTimes(2)
      await back.click()
      await expect
        .element(page.getByRole('textbox'))
        .toHaveValue('Example workspace')
    } finally {
      await act(() => root.unmount())
      container.remove()
      router.dispose()
    }
  },
)
