// @vitest-environment happy-dom
// A Settings confirmation fetches its recipients or estimate mid-submission.
// When the session has expired, the resource answers 401 instead of a sign-in
// redirect to itself, and the open confirmation sends the user to sign in with
// the Settings page they are on as the return target. The resources run on the
// real request handler and reach the confirmations through the router's own
// Single Fetch transport; only the services, Stripe and auth provider are local.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createMemoryRouter,
  createRequestHandler,
  Outlet,
  RouterContextProvider,
  RouterProvider,
  UNSAFE_createClientRoutes,
  UNSAFE_getTurboStreamSingleFetchDataStrategy,
  useLocation,
  useRouteError,
  type DataRouter,
  type DataStrategyFunction,
  type ServerBuild,
  type UNSAFE_AssetsManifest,
  type UNSAFE_RouteModules,
} from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'
import * as entry from '~/entry.server'
import { formatPrice } from '~/lib/billing-prices'
import { isSessionExpired } from '~/lib/session-expired'
import { bindI18n } from '~/lib/i18n'
import type { SessionUser } from '~/lib/user'
import { userContext } from '~/middleware/context'
import * as dom from '~/test/dom-actions'
import { Landing } from '../../_home/+components/landing'
import SignIn from '../../sign-in'
import BillingPage from './_content/billing'
import TeamMembersPage from './_content/index'
import * as billingPreview from './billing-preview'
import * as recipients from './recipients'

vi.mock('cloudflare:workers', () => ({
  env: { STRIPE_SECRET_KEY: 'local-test-only' },
}))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))
const workspaceRow = {
  id: 'ws1',
  plan: 'team',
  stripe_customer_id: 'cus_1',
  stripe_subscription_id: 'sub_1',
  stripe_subscription_status: 'active',
}
vi.mock('~/services/db.server', () => ({
  createDb: () => ({
    selectFrom: () => ({
      select: () => ({
        where: () => ({ executeTakeFirstOrThrow: async () => workspaceRow }),
      }),
    }),
  }),
}))
const services = vi.hoisted(() => ({
  search: vi.fn(),
  preview: vi.fn(),
}))
vi.mock('~/services/team-management.server', () => ({
  requireWorkspaceAdmin: async () => ({ kind: 'ok' }),
  searchAssetTransferRecipients: services.search,
  requireWorkspaceOwner: async () => ({ kind: 'ok' }),
}))
vi.mock('~/services/billing.server', async (original) => ({
  ...(await original<typeof import('~/services/billing.server')>()),
  isBillingConfigured: () => true,
  createStripeClient: () => ({}),
  previewPlanChange: services.preview,
}))
// The provider and email-code boundaries.
const auth = vi.hoisted(() => ({
  social: vi.fn(),
  sendSignInOtp: vi.fn(async () => ({})),
  signInWithOtp: vi.fn(async () => ({})),
}))
vi.mock('~/lib/auth-client', () => ({
  signIn: { social: auth.social },
  sendSignInOtp: auth.sendSignInOtp,
  signInWithOtp: auth.signInWithOtp,
}))

const t = bindI18n('en').t
const viewer: SessionUser = {
  id: 'owner',
  email: 'owner@example.test',
  emailVerified: true,
  workspaceId: 'ws1',
  kind: 'human',
  name: null,
  image: null,
  locale: null,
  hd: null,
  msTenantId: null,
}
const healthyEstimate = {
  kind: 'ok' as const,
  currency: 'usd' as const,
  nextInvoiceAt: null,
}
/** A distinct proration per change, so the amount in the dialog says which
 * change was previewed. The plan downgrade credits, the longer interval
 * charges. */
const prorationFor = { 'plus-monthly': -16.5, 'team-yearly': 261 }
type Change = keyof typeof prorationFor
const prorationText = (change: Change) =>
  t(
    prorationFor[change] < 0
      ? 'billing.confirm.prorationCredit'
      : 'billing.confirm.prorationCharge',
    { amount: formatPrice('usd', Math.abs(prorationFor[change])) },
  )

let session: SessionUser | null = viewer
let held: Promise<void> | null = null

beforeEach(() => {
  session = viewer
  held = null
  services.search.mockResolvedValue({
    recipients: [{ id: 'robin', name: 'Robin', email: 'robin@example.test' }],
    total: 1,
  })
  services.preview.mockImplementation(
    async (
      _stripe: unknown,
      _env: unknown,
      _workspace: unknown,
      plan: string,
      interval: string,
    ) => ({
      ...healthyEstimate,
      prorationAmount: prorationFor[`${plan}-${interval}` as Change] ?? 0,
    }),
  )
})
afterEach(() => {
  auth.social.mockClear()
  auth.signInWithOtp.mockClear()
})

const resources = {
  recipients: { path: 'settings/recipients', module: recipients },
  preview: { path: 'settings/billing-preview', module: billingPreview },
}
const flags = {
  hasAction: false,
  hasClientAction: false,
  hasClientMiddleware: false,
  hasErrorBoundary: false,
  clientActionModule: undefined,
  clientLoaderModule: undefined,
  clientMiddlewareModule: undefined,
  hydrateFallbackModule: undefined,
}

function serverHandler() {
  const build: ServerBuild = {
    entry: { module: entry },
    assets: {
      entry: { module: '/entry.client.js', imports: [] },
      url: '/manifest.js',
      version: 'expired-session',
      routes: {
        root: {
          ...flags,
          hasLoader: false,
          hasClientLoader: false,
          id: 'root',
          path: '',
          module: '/root.js',
        },
        ...Object.fromEntries(
          Object.entries(resources).map(([id, { path }]) => [
            id,
            {
              ...flags,
              hasLoader: true,
              hasClientLoader: true,
              id,
              parentId: 'root',
              path,
              module: `/${id}.js`,
            },
          ]),
        ),
      },
    },
    publicPath: '/',
    assetsBuildDirectory: 'build/client',
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: 'initial', manifestPath: '/__manifest' },
    routes: {
      root: { id: 'root', path: '', module: { default: () => null } },
      ...Object.fromEntries(
        Object.entries(resources).map(([id, { path, module }]) => [
          id,
          { id, parentId: 'root', path, module },
        ]),
      ),
    },
  }
  const handler = createRequestHandler(build, 'production')
  return (request: Request) => {
    const context = new RouterContextProvider()
    context.set(userContext, session)
    return handler(request, context)
  }
}

describe('the confirmation resources', () => {
  test.each([
    ['recipients', '/settings/recipients.data?q=ro&_routes=recipients'],
    [
      'preview',
      '/settings/billing-preview.data?plan=plus&interval=monthly&_routes=preview',
    ],
  ])(
    '%s answers an expired session with 401 and no redirect',
    async (_, url) => {
      session = null
      const response = await serverHandler()(
        new Request(`https://example.test${url}`),
      )
      expect(response.status).toBe(401)
      expect(response.headers.get('Location')).toBeNull()
      expect(response.headers.get('X-Remix-Redirect')).toBeNull()
    },
  )
})

function Where() {
  const location = useLocation()
  return (
    <output data-testid="where">
      {location.pathname + location.search + location.hash}
    </output>
  )
}

function teamMember(id: string, role: 'owner' | 'member') {
  return {
    id,
    email: `${id}@example.test`,
    name: id,
    image: null,
    firstContributedAt: null,
    lastContributedAt: null,
    pendingUploads: 0,
    isAdmin: role !== 'member',
    role,
  }
}
// The members page, whose removal confirmation searches for recipients.
const members = (
  <TeamMembersPage
    loaderData={{
      membersPage: {
        members: [teamMember('owner', 'owner'), teamMember('casey', 'member')],
        total: 2,
        page: 1,
      },
      removedMembers: [],
      filters: { query: '', role: 'all', activity: 'all', page: 1 },
    }}
  />
)
const contract = {
  plan: 'team' as const,
  interval: 'monthly' as const,
  currency: 'jpy' as const,
  amount: 4500,
  renewsAt: '2030-08-15T00:00:00.000Z',
  cancelAtPeriodEnd: false,
}
const billing = (
  <BillingPage
    loaderData={{
      showOverageProjection: false,
      includedBytes: 100 * 1024 ** 3,
      overageProjection: null,
      contributorCount: null,
      contract,
      canManage: true,
      stripeSubscriptionStatus: 'active',
      hasSubscription: true,
      billingConfigured: true,
      defaultCurrency: 'jpy',
      initialPlan: 'team',
      initialInterval: 'monthly',
      activeProjectCount: 1,
      projectLimit: null,
      entryContext: 'default',
      externalPostingEnabled: true,
      monthlyEstimate: null,
    }}
  />
)

/** A browser router whose confirmation fetches go through Single Fetch. */
async function mount(start: string) {
  const handle = serverHandler()
  const page = { hasLoader: false, hasClientLoader: false, parentId: 'root' }
  const manifest: UNSAFE_AssetsManifest = {
    entry: { module: '', imports: [] },
    url: '',
    version: 'test',
    routes: {
      root: {
        ...flags,
        hasLoader: false,
        hasClientLoader: false,
        hasErrorBoundary: true,
        id: 'root',
        path: '',
        module: '',
      },
      members: {
        ...flags,
        ...page,
        id: 'members',
        path: 'settings',
        module: '',
      },
      billing: {
        ...flags,
        ...page,
        id: 'billing',
        path: 'settings/billing',
        module: '',
      },
      landing: { ...flags, ...page, id: 'landing', index: true, module: '' },
      signIn: { ...flags, ...page, id: 'signIn', path: 'sign-in', module: '' },
      ...Object.fromEntries(
        Object.entries(resources).map(([id, { path }]) => [
          id,
          {
            ...flags,
            hasLoader: true,
            hasClientLoader: true,
            id,
            parentId: 'root',
            path,
            module: '',
          },
        ]),
      ),
    },
  }
  const modules: UNSAFE_RouteModules = {
    root: {
      default: () => (
        <TooltipProvider>
          <Outlet
            context={{
              // The Settings shell the pages receive from their layout.
              kind: 'team',
              currentUserIsAdmin: true,
              currentUserRole: 'owner',
              user: {
                id: 'owner',
                email: 'owner@example.test',
                name: 'owner',
                initial: 'O',
                image: null,
              },
              workspace: {
                plan: 'team',
                storageUsedBytes: 0,
                storageQuotaBytes: 100 * 1024 ** 3,
              },
            }}
          />
          <Where />
        </TooltipProvider>
      ),
      ErrorBoundary: () => {
        throw useRouteError()
      },
      HydrateFallback: () => null,
    },
    members: { default: () => members },
    billing: { default: () => billing },
    landing: { default: () => <Landing /> },
    signIn: { default: () => <SignIn /> },
    recipients: { default: () => null, clientLoader: recipients.clientLoader },
    preview: { default: () => null, clientLoader: billingPreview.clientLoader },
  }
  let router: DataRouter | undefined
  // What each resource answered, as the transport received it.
  const responses: Array<{ path: string; status: number }> = []
  const transport = UNSAFE_getTurboStreamSingleFetchDataStrategy(
    () => {
      if (!router) throw new Error('router not ready')
      return router
    },
    manifest,
    modules,
    false,
    async (request) => {
      if (held) await held
      const response = await handle(request)
      responses.push({
        path: new URL(request.url).pathname,
        status: response.status,
      })
      return response
    },
  )
  const dataStrategy: DataStrategyFunction = (args) =>
    args.fetcherKey
      ? transport(args)
      : args.runClientMiddleware(async (inner) =>
          Object.fromEntries(
            await Promise.all(
              inner.matches
                .filter((match) => match.shouldCallHandler())
                .map(async (match) => [match.route.id, await match.resolve()]),
            ),
          ),
        )
  router = createMemoryRouter(
    UNSAFE_createClientRoutes(manifest.routes, modules, null, false, false),
    { initialEntries: [start], dataStrategy },
  )
  // Every settled fetcher result the router hands to the page.
  const fetched: unknown[] = []
  router.subscribe((state) => {
    for (const fetcher of state.fetchers.values())
      if (fetcher.state === 'idle' && fetcher.data !== undefined)
        fetched.push(fetcher.data)
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const dataRouter = router
  await act(async () => root.render(<RouterProvider router={dataRouter} />))
  return {
    router: dataRouter,
    responses,
    fetched,
    container,
    where: () => container.querySelector('[data-testid="where"]')?.textContent,
    unmount: () => {
      act(() => root.unmount())
      container.remove()
      dataRouter.dispose()
    },
  }
}

/** The copy each change's button leads with; the interval button follows its
 * label with a saving note. */
const changeLabel: Record<Change, string> = {
  'plus-monthly': t('billing.change.plan.downgrade'),
  'team-yearly': t('billing.change.interval.toYearly'),
}

async function pressChange(container: HTMLElement, change: Change) {
  await dom.press(
    await dom.find(() =>
      dom.byRole(container, 'button', (name) =>
        name.startsWith(changeLabel[change]),
      ),
    ),
  )
}

const pressPlanChange = (container: HTMLElement) =>
  pressChange(container, 'plus-monthly')

async function openPlanChange(container: HTMLElement) {
  await pressPlanChange(container)
  return dom.find(() => dom.byRole(document.body, 'alertdialog'))
}

/** Opens the removal confirmation for Casey, which searches for recipients. */
async function openRemoval(container: HTMLElement) {
  await dom.press(
    await dom.find(() =>
      dom.byRole(container, 'button', t('team.members.menu')),
    ),
  )
  await dom.press(
    await dom.find(() =>
      dom.byRole(document.body, 'menuitem', t('team.members.remove')),
    ),
  )
  return dom.find(() => dom.byRole(document.body, 'alertdialog'))
}

/** Opens each page's confirmation, which fetches its resource. */
const openConfirmation = {
  members: openRemoval,
  billing: pressPlanChange,
}

const membersPage = '/settings?q=casey#members'
const billingPage = '/settings/billing?source=usage#plans'
const signInEntry = (page: string) => `/?next=${encodeURIComponent(page)}`
const resourceOf = {
  members: '/settings/recipients.data',
  billing: '/settings/billing-preview.data',
}

describe('a valid session', () => {
  test('recipient search shows its results in the removal confirmation', async () => {
    const screen = await mount(membersPage)
    try {
      const dialog = await openRemoval(screen.container)
      await dom.find(() =>
        dom.byRole(dialog, 'radio', (name) => name.includes('Robin')),
      )
      expect(screen.where()).toBe(membersPage)
    } finally {
      screen.unmount()
    }
  })

  // The estimate answers per plan and interval, so the amount in the dialog is
  // the one for the change the user opened, not for another one.
  test.each(['plus-monthly', 'team-yearly'] as const)(
    'opening the %s change shows that change in its own proration',
    async (change) => {
      const screen = await mount(billingPage)
      try {
        await pressChange(screen.container, change)
        const dialog = await dom.find(() =>
          dom.byRole(document.body, 'alertdialog'),
        )
        await vi.waitFor(() =>
          expect(dialog.textContent).toContain(prorationText(change)),
        )
        expect(screen.where()).toBe(billingPage)
      } finally {
        screen.unmount()
      }
    },
  )
})

describe('an expired session during a confirmation', () => {
  test('the recipient search sends the user to sign in, returning to the Settings page', async () => {
    const screen = await mount(membersPage)
    try {
      session = null
      await openRemoval(screen.container)
      await vi.waitFor(() =>
        expect(screen.where()).toBe(signInEntry(membersPage)),
      )
    } finally {
      screen.unmount()
    }
  })

  test('the plan change estimate sends the user to sign in, returning to the Settings page', async () => {
    const screen = await mount(billingPage)
    try {
      session = null
      await pressPlanChange(screen.container)
      await vi.waitFor(() =>
        expect(screen.where()).toBe(signInEntry(billingPage)),
      )
    } finally {
      screen.unmount()
    }
  })

  test('a late 401 for a dismissed confirmation does not reach the next one', async () => {
    const screen = await mount(billingPage)
    try {
      session = null
      let release = () => {}
      held = new Promise((resolve) => {
        release = resolve
      })
      const dialog = await openPlanChange(screen.container)
      await dom.press(
        await dom.find(() => dom.byRole(dialog, 'button', t('confirm.cancel'))),
      )
      await vi.waitFor(() =>
        expect(dom.byRole(document.body, 'alertdialog')).toBeNull(),
      )
      // The dismissed confirmation's estimate now answers 401 and settles.
      held = null
      release()
      await vi.waitFor(() =>
        expect(
          [...screen.router.state.fetchers.values()].filter(
            ({ state }) => state !== 'idle',
          ),
        ).toEqual([]),
      )
      // The next opening's estimate is still on its way when it opens.
      session = viewer
      held = new Promise((resolve) => {
        release = resolve
      })
      const reopened = await openPlanChange(screen.container)
      await vi.waitFor(() =>
        expect(
          [...screen.router.state.fetchers.values()].some(
            ({ state }) => state === 'loading',
          ),
        ).toBe(true),
      )
      held = null
      release()
      await vi.waitFor(() =>
        expect(reopened.textContent).toContain(prorationText('plus-monthly')),
      )
      expect(screen.where()).toBe(billingPage)
    } finally {
      screen.unmount()
    }
  })

  test('a 401 for a confirmation the user has moved away from does not send them to sign in', async () => {
    const screen = await mount(billingPage)
    try {
      session = null
      let release = () => {}
      held = new Promise((resolve) => {
        release = resolve
      })
      const dialog = await openPlanChange(screen.container)
      await vi.waitFor(() =>
        expect(
          [...screen.router.state.fetchers.values()].some(
            ({ state }) => state === 'loading',
          ),
        ).toBe(true),
      )
      // The user moves to another entry of the same page and the expired
      // estimate settles in the same update.
      const departed = '/settings/billing?source=other'
      held = null
      expect(dialog.isConnected).toBe(true)
      // Both land in one render: the confirmation is still open, on the old
      // entry, when it receives the expired estimate.
      await act(async () => {
        const moving = screen.router.navigate(departed)
        release()
        await moving
        await vi.waitFor(() =>
          expect(screen.fetched.some(isSessionExpired)).toBe(true),
        )
      })
      // The stale estimate did answer 401.
      expect(screen.responses).toContainEqual({
        path: '/settings/billing-preview.data',
        status: 401,
      })
      await act(async () => {})
      // Neither the page it was opened on nor the new entry is a sign-in target.
      expect(screen.where()).not.toBe(signInEntry(billingPage))
      expect(screen.where()).not.toBe(signInEntry(departed))
      expect(screen.where()).toBe(departed)
    } finally {
      screen.unmount()
    }
  })

  test.each([
    ['members', membersPage],
    ['billing', billingPage],
  ] as const)(
    'email and Google sign-in both return to the %s page they left',
    async (page, origin) => {
      const screen = await mount(origin)
      // The session expires while the user confirms on the page.
      session = null
      await openConfirmation[page](screen.container)
      await vi.waitFor(() =>
        expect(screen.where()?.startsWith('/?next=')).toBe(true),
      )
      // The resource answered 401 itself; the confirmation chose the entry.
      expect(screen.responses).toContainEqual({
        path: resourceOf[page],
        status: 401,
      })
      session = viewer
      const assign = vi.fn()
      const original = window.location
      Object.defineProperty(window, 'location', {
        configurable: true,
        value: {
          ...original,
          set href(value: string) {
            assign(value)
          },
        },
      })
      try {
        // Google: the provider returns to the callback the landing supplies.
        await dom.press(
          await dom.find(() =>
            dom.byRole(screen.container, 'button', (name) =>
              name.includes(t('lp.cta')),
            ),
          ),
        )
        expect(auth.social).toHaveBeenCalledWith(
          expect.objectContaining({ provider: 'google', callbackURL: origin }),
        )
        // Email: the code page navigates to `next` after a verified code.
        await dom.press(
          await dom.find(() =>
            dom.byRole(screen.container, 'link', (name) =>
              name.startsWith(t('signin.email.toggle')),
            ),
          ),
        )
        await vi.waitFor(() =>
          expect(screen.where()?.startsWith('/sign-in')).toBe(true),
        )
        await dom.fill(
          await dom.find(() =>
            dom.byRole(
              screen.container,
              'textbox',
              t('signin.email.placeholder'),
            ),
          ),
          'owner@example.test',
        )
        await dom.press(
          await dom.find(() =>
            dom.byRole(screen.container, 'button', t('signin.otp.send')),
          ),
        )
        await dom.fill(
          await dom.find(() =>
            dom.byRole(
              screen.container,
              'textbox',
              t('signin.otp.placeholder'),
            ),
          ),
          '123456',
        )
        await dom.press(
          await dom.find(() =>
            dom.byRole(screen.container, 'button', t('signin.otp.verify')),
          ),
        )
        await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1))
        // Both returns load the Settings page the user was on.
        for (const destination of [
          assign.mock.calls[0]?.[0],
          auth.social.mock.calls[0]?.[0].callbackURL,
        ]) {
          await act(() => screen.router.navigate(destination))
          expect(screen.where()).toBe(origin)
        }
      } finally {
        Object.defineProperty(window, 'location', {
          configurable: true,
          value: original,
        })
        screen.unmount()
      }
    },
  )
})

describe('an ordinary failure keeps the confirmation open', () => {
  test('a failed recipient search shows its alert in the open removal confirmation', async () => {
    services.search.mockRejectedValue(new Error('search unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const screen = await mount(membersPage)
    try {
      const dialog = await openRemoval(screen.container)
      const alert = await dom.find(() => dom.byRole(dialog, 'alert'))
      expect(alert.textContent).toBe(t('team.members.assetTransfer.error'))
      expect(dialog.isConnected).toBe(true)
      expect(screen.where()).toBe(membersPage)
    } finally {
      screen.unmount()
      vi.restoreAllMocks()
    }
  })

  test('an unavailable estimate shows its fallback in the open dialog', async () => {
    services.preview.mockResolvedValue({ kind: 'external-failed' })
    const screen = await mount(billingPage)
    try {
      const dialog = await openPlanChange(screen.container)
      await vi.waitFor(() =>
        expect(dialog.textContent).toContain(
          t('billing.confirm.previewUnavailable'),
        ),
      )
      expect(screen.where()).toBe(billingPage)
    } finally {
      screen.unmount()
    }
  })
})
