import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  RouterProvider,
  RouterContextProvider,
  UNSAFE_withComponentProps,
  useRouteError,
  type LoaderFunctionArgs,
  type MiddlewareFunction,
  type RouteObject,
} from 'react-router'
import { expect, test, vi } from 'vitest'
import { page, userEvent, commands } from 'vitest/browser'
import '~/app.css'
import { TooltipProvider } from '~/components/ui/tooltip'
import { bindI18n } from '~/lib/i18n'
import { SettingsUnderAppShell } from '~/test/app-shell-page'
import SettingsContent, { ErrorBoundary } from './_layout'
import * as admin from './+admin/_layout'
import * as bots from './bots'
import * as activity from './activity'
import * as inventory from './inventory/_layout'
import * as inventoryIndex from './inventory/index'
import * as inventoryProjects from './inventory/projects'
import * as inventoryArtifacts from './inventory/artifacts'
import GeneralPage, { action as updateGeneral } from './general'
import BillingPage from './billing'

const { updateWorkspaceName, viewer, adminReads, adminRead } = vi.hoisted(
  () => {
    // The admin data each guarded page reads once the gate admits the viewer.
    const reads: string[] = []
    return {
      updateWorkspaceName: vi.fn(),
      viewer: { role: 'member' as 'member' | 'admin' },
      adminReads: reads,
      adminRead: (name: string) => async () => {
        reads.push(name)
        throw new Error(`${name} reached`)
      },
    }
  },
)
vi.mock('~/services/team-management.server', () => ({
  updateWorkspaceName,
  loadAuditEventsPage: adminRead('activity'),
  loadWorkspaceInventoryProjectsPage: adminRead('inventory projects'),
  loadWorkspaceInventoryArtifactsPage: adminRead('inventory artifacts'),
  parseInventoryArtifactsFilters: () => ({}),
}))
vi.mock('~/services/bot-members.server', () => ({
  listWorkspaceBots: adminRead('bots'),
}))
vi.mock('~/services/bot-destinations.server', () => ({}))
vi.mock('~/lib/bot-members-flag.server', () => ({
  isBotMembersEnabled: async () => false,
}))
vi.mock('~/services/project-membership.server', () => ({}))
vi.mock('~/services/billing.server', () => ({}))
vi.mock('~/services/billing-usage.server', () => ({}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner', workspaceId: 'ws' }),
}))
// The viewer's active membership, as the admin gate reads it.
vi.mock('../+lib/settings-request.server', () => ({
  settingsActiveRole: async () => viewer.role,
  settingsWorkspace: async () => ({ plan: 'team' }),
}))

test.each(['loader', 'action', 'preview'])(
  'retains the Settings shell after a thrown %s and recovers',
  async (fault) => {
    await page.viewport(fault === 'loader' ? 390 : 1440, 844)
    let shouldThrow = false
    updateWorkspaceName.mockImplementation(() => {
      if (shouldThrow) throw new Error('action failed')
      return { kind: 'invalid' }
    })
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
              <SettingsUnderAppShell
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
                  element: <GeneralPage loaderData={{ owner: null }} />,
                  action: (args) =>
                    updateGeneral({
                      ...args,
                      context: new RouterContextProvider(),
                      pattern: '/settings/general',
                      url: new URL(args.request.url),
                    }),
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
                        stripeSubscriptionStatus: 'active',
                        hasSubscription: true,
                        billingConfigured: true,
                        defaultCurrency: 'usd',
                        initialPlan: 'team',
                        initialInterval: 'monthly',
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
        await page.getByRole('button', { name: 'Save' }).click()
        await expect
          .element(page.getByText('Check your input and try again.'))
          .toBeVisible()
        shouldThrow = true
        await page.getByRole('button', { name: 'Save' }).click()
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
      // The recovery link, top bar and Settings navigation stay visible.
      for (const selector of [
        '[data-screen-capture-error="settings-error-boundary"] a[href="/settings"]',
        '#app-topbar',
        'main nav a[href="/settings/billing"], main button[data-slot="sheet-trigger"]',
      ])
        await vi.waitFor(() =>
          expect(
            [...container.querySelectorAll<HTMLElement>(selector)].some(
              (element) =>
                element.checkVisibility({ visibilityProperty: true }),
            ),
          ).toBe(true),
        )
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

const SETTINGS = 'routes/_protected/settings'

// The framework hands each route its typed arguments; this does the same for
// the real loaders.
const at = (pattern: string, args: LoaderFunctionArgs) => ({
  ...args,
  params: {},
  pattern,
  url: new URL(args.request.url),
})

/** A server middleware run as the browser router runs route middleware. */
function inBrowser(
  middleware: MiddlewareFunction<Response>,
): MiddlewareFunction {
  return async (args, next) => {
    let result: unknown
    await middleware(args, async () => {
      result = await next()
      return new Response()
    })
    return result
  }
}

/**
 * The real modules of the Settings routes between the shell and the gate,
 * keyed by their source files.
 */
const settingsModules: Record<
  string,
  Omit<RouteObject, 'id' | 'path' | 'index' | 'children'>
> = {
  [`${SETTINGS}/_content/_layout.tsx`]: {
    Component: SettingsContent,
    ErrorBoundary: () => <ErrorBoundary error={useRouteError()} />,
  },
  // Where the back link leads; the general page stands in for the members
  // page, whose data this does not need.
  [`${SETTINGS}/_content/index.tsx`]: {
    element: <GeneralPage loaderData={{ owner: null }} />,
  },
  [`${SETTINGS}/_content/+admin/_layout.tsx`]: {
    middleware: admin.middleware.map(inBrowser),
    Component: admin.default,
  },
  [`${SETTINGS}/_content/bots.tsx`]: {
    loader: (args) => bots.loader(at('/settings/bots', args)),
    Component: UNSAFE_withComponentProps(bots.default),
  },
  [`${SETTINGS}/_content/activity.tsx`]: {
    loader: (args) => activity.loader(at('/settings/activity', args)),
    Component: UNSAFE_withComponentProps(activity.default),
  },
  [`${SETTINGS}/_content/inventory/_layout.tsx`]: {
    Component: inventory.default,
  },
  [`${SETTINGS}/_content/inventory/index.tsx`]: {
    loader: (args) => inventoryIndex.loader(at('/settings/inventory', args)),
    Component: inventoryIndex.default,
  },
  [`${SETTINGS}/_content/inventory/projects.tsx`]: {
    loader: (args) =>
      inventoryProjects.loader(at('/settings/inventory/projects', args)),
    Component: UNSAFE_withComponentProps(inventoryProjects.default),
  },
  [`${SETTINGS}/_content/inventory/artifacts.tsx`]: {
    loader: (args) =>
      inventoryArtifacts.loader(at('/settings/inventory/artifacts', args)),
    Component: UNSAFE_withComponentProps(inventoryArtifacts.default),
  },
}

/**
 * The modules above, mounted where the production route tree places each
 * route and from the file that route is configured to load.
 */
async function productionSettingsRoutes() {
  const tree = await commands.settingsRouteTree()
  expect(tree.map(({ file }) => file)).toEqual(
    expect.arrayContaining(Object.keys(settingsModules)),
  )
  const place = (parentId: string): RouteObject[] =>
    tree
      .filter(
        (node) => node.parentId === parentId && node.file in settingsModules,
      )
      .map((node) =>
        node.index
          ? { id: node.id, index: true, ...settingsModules[node.file] }
          : {
              id: node.id,
              path: node.path,
              ...settingsModules[node.file],
              children: place(node.id),
            },
      )
  return place(`${SETTINGS}/_layout`)
}

const guardedPages = [
  ['/settings/bots', 'bots', '/settings/bots'],
  ['/settings/activity', 'activity', '/settings/activity'],
  ['/settings/inventory', 'inventory projects', '/settings/inventory/projects'],
  [
    '/settings/inventory/projects',
    'inventory projects',
    '/settings/inventory/projects',
  ],
  [
    '/settings/inventory/artifacts',
    'inventory artifacts',
    '/settings/inventory/artifacts',
  ],
] as const

/** Settings for a viewer whose active role the admin gate reads. */
async function settingsFor(role: 'member' | 'admin') {
  viewer.role = role
  adminReads.length = 0
  return createMemoryRouter(
    [
      {
        path: 'settings',
        errorElement: <div data-screen-capture-error="route-error-boundary" />,
        element: (
          <TooltipProvider>
            <SettingsUnderAppShell
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
                currentUserIsAdmin: role === 'admin',
                currentUserRole: role,
                user: {
                  id: role,
                  email: `${role}@example.test`,
                  name: role,
                  initial: 'M',
                  image: null,
                },
              }}
            />
          </TooltipProvider>
        ),
        children: await productionSettingsRoutes(),
      },
    ],
    { initialEntries: ['/settings'] },
  )
}

test('an admin passes the same gate to each page and its data', async () => {
  await page.viewport(1440, 844)
  const { t } = bindI18n('en')
  const router = await settingsFor('admin')
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    for (const [url, read, landing] of guardedPages) {
      adminReads.length = 0
      await act(() => router.navigate(url))
      // The page went on to read its admin data, past the gate.
      await vi.waitFor(() => expect(adminReads, url).toEqual([read]))
      expect(router.state.location.pathname, url).toBe(landing)
      expect(container.textContent, url).not.toContain(
        t('settings.error.forbidden.title'),
      )
    }
  } finally {
    await act(() => root.unmount())
    container.remove()
    router.dispose()
    error.mockRestore()
  }
})

test.each([1440, 390])(
  'a member opening an admin-only page gets the Settings 403 at its URL (%ipx)',
  async (width) => {
    await page.viewport(width, 844)
    const { t } = bindI18n('en')
    const router = await settingsFor('member')
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      await expect
        .element(page.getByRole('textbox'))
        .toHaveValue('Example workspace')
      for (const [url] of guardedPages) {
        await act(() => router.navigate(url))
        await expect
          .element(page.getByText(t('settings.error.forbidden.title')))
          .toBeVisible()
        expect(router.state.location.pathname, url).toBe(url)
        expect(
          container.querySelector(
            '[data-screen-capture-error="settings-error-boundary"]',
          ),
          url,
        ).not.toBeNull()
        // The refusal comes before any admin data is read.
        expect(adminReads, url).toEqual([])
        // The Settings page keeps its own bars around the refusal; the bottom
        // bar is the mobile one.
        for (const bar of width === 390
          ? ['#app-topbar', '[data-bottom-tab-bar]']
          : ['#app-topbar'])
          await expect
            .element(page.elementLocator(container.querySelector(bar)!))
            .toBeVisible()
        await page.getByRole('link', { name: t('settings.error.back') }).click()
        await expect
          .element(page.getByRole('textbox'))
          .toHaveValue('Example workspace')
        expect(router.state.location.pathname).toBe('/settings')
      }
    } finally {
      await act(() => root.unmount())
      container.remove()
      router.dispose()
    }
  },
)
