// One Settings request reads the shell once: the workspace row, the viewer's
// active role and the joined projects, whichever loaders and middleware ask.
// Requests run on the real request handler with the production route tree;
// hydrated revalidations come from the router's own Single Fetch client, so
// which loaders a request runs is decided by the framework, not by the test.
import { createElement } from 'react'
import { SelectQueryNode, type PluginTransformQueryArgs } from 'kysely'
import {
  createMemoryRouter,
  createRequestHandler,
  Outlet,
  RouterContextProvider,
  UNSAFE_createClientRoutes,
  UNSAFE_getTurboStreamSingleFetchDataStrategy,
  type DataRouter,
  type LoaderFunctionArgs,
  type ServerBuild,
  type UNSAFE_RouteModules,
} from 'react-router'
import { beforeEach, expect, test, vi } from 'vitest'
import * as entry from '~/entry.server'
import { userContext } from '~/middleware/context'
import { discoverRoutes } from '~/routes'
import * as billingUsage from '~/services/billing-usage.server'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import * as protectedLayout from '../_layout'
import * as settingsLayout from './_layout'
import * as admin from './_content/+admin/_layout'
import * as members from './_content/index'
import * as bots from './_content/bots'
import * as billing from './_content/billing'
import * as externalAccess from './_content/external-access'

vi.mock('cloudflare:workers', () => ({ env: {} }))
const reads = vi.hoisted(() => ({
  queries: [] as Array<{ sql: string; parameters: readonly unknown[] }>,
}))
vi.mock('~/services/db.server', () => ({
  createDb: () =>
    fixture.db.withPlugin({
      transformQuery: ({ node, queryId }: PluginTransformQueryArgs) => {
        if (SelectQueryNode.is(node))
          reads.queries.push(
            fixture.db.getExecutor().compileQuery(node, queryId),
          )
        return node
      },
      transformResult: async ({ result }) => result,
    }),
}))
vi.mock('~/services/link-sharing.server', async (original) => ({
  ...(await original<typeof import('~/services/link-sharing.server')>()),
  loadWorkspaceLinkPolicy: policyReads,
}))
const joined = vi.hoisted(() => vi.fn(async () => []))
const policyReads = vi.hoisted(() => vi.fn())
vi.mock('~/services/project-membership.server', () => ({
  listJoinedProjectsForDropdown: joined,
}))
vi.mock('~/lib/bot-members-flag.server', () => ({
  isBotMembersEnabled: async () => false,
}))
const contract = {
  plan: 'plus' as const,
  interval: 'monthly' as const,
  currency: 'usd' as const,
  amount: 5,
  renewsAt: '2030-01-01T00:00:00.000Z',
  cancelAtPeriodEnd: false,
}
vi.mock('~/services/billing.server', async (original) => ({
  ...(await original<typeof import('~/services/billing.server')>()),
  isBillingConfigured: () => true,
  createStripeClient: () => ({}),
  loadSubscriptionContract: async () => contract,
}))

const fixture = createMigratedInMemoryDb()
// The router's Single Fetch client runs as in a browser on the app's origin:
// it addresses requests from the window's location and decodes responses
// against the window's global scope, here Node's.
vi.stubGlobal('window', globalThis)
vi.stubGlobal('location', new URL('https://example.test/'))

const workspaceReads = () =>
  reads.queries.filter(({ sql }) => /\bfrom "workspaces"/.test(sql)).length
/**
 * Lookups of the viewer's own active membership, whatever they select: the
 * shell's role read, an admin or owner check. Member lists and removed-member
 * reads are feature data and do not filter by the viewer.
 */
const viewerMembershipReads = (viewer: string) =>
  reads.queries.filter(
    ({ sql, parameters }) =>
      /\bfrom "workspace_members"/.test(sql) &&
      /"user_id" = \?/.test(sql) &&
      parameters.includes(viewer) &&
      parameters.includes('active'),
  ).length

function signedIn(viewer: string) {
  const context = new RouterContextProvider()
  context.set(userContext, {
    id: viewer,
    email: `${viewer}@example.com`,
    emailVerified: true,
    workspaceId: 'ws1',
    kind: 'human',
    name: null,
    image: null,
    locale: null,
    hd: null,
    msTenantId: null,
  })
  return context
}

const SETTINGS = 'routes/_protected/settings'
const SHELL = `${SETTINGS}/_layout`
const MEMBERS = `${SETTINGS}/_content/index`
const EXTERNAL_ACCESS = `${SETTINGS}/_content/external-access`
const BILLING = `${SETTINGS}/_content/billing`

type RouteModule = NonNullable<ServerBuild['routes'][string]>['module']

// The framework build hands each route its typed arguments; this does the
// same for the real loaders.
const at = (pattern: string, args: LoaderFunctionArgs) => ({
  ...args,
  params: {},
  pattern,
  url: new URL(args.request.url),
})

// The real loaders and middleware of the Settings routes. Components and the
// pages' actions are not what this counts: a submission only has to reach
// the server so the client decides what to revalidate.
const modules: Record<string, RouteModule> = {
  'routes/_protected/_layout': {
    middleware: protectedLayout.middleware,
    default: Outlet,
  },
  [SHELL]: {
    loader: (args) => settingsLayout.loader(at('/settings', args)),
    default: Outlet,
  },
  [`${SETTINGS}/_content/_layout`]: { default: Outlet },
  [`${SETTINGS}/_content/_admin`]: {
    middleware: admin.middleware,
    default: Outlet,
  },
  [MEMBERS]: {
    loader: (args) => members.loader(at('/settings', args)),
    action: () => null,
    default: Outlet,
  },
  [EXTERNAL_ACCESS]: {
    loader: (args) =>
      externalAccess.loader(at('/settings/external-access', args)),
    action: () => null,
    default: Outlet,
  },
  [BILLING]: {
    loader: (args) => billing.loader(at('/settings/billing', args)),
    default: Outlet,
  },
  [`${SETTINGS}/_content/bots`]: {
    loader: (args) => bots.loader(at('/settings/bots', args)),
    default: Outlet,
  },
}

type Entry = ReturnType<typeof discoverRoutes>[number]
function placed(
  routes: Entry[],
  parentId = 'root',
): Array<Entry & { parentId: string }> {
  return routes.flatMap((route) => [
    { ...route, parentId },
    ...placed(route.children ?? [], route.id),
  ])
}

const routes = placed(discoverRoutes(false)).filter(
  (route) => route.id in modules,
)
const flags = {
  hasClientAction: false,
  hasClientLoader: false,
  hasClientMiddleware: false,
  hasErrorBoundary: false,
  clientActionModule: undefined,
  clientLoaderModule: undefined,
  clientMiddlewareModule: undefined,
  hydrateFallbackModule: undefined,
}
const build: ServerBuild = {
  entry: { module: entry },
  assets: {
    entry: { module: '/entry.client.js', imports: [] },
    url: '/manifest.js',
    version: 'settings-shell-reads',
    routes: {
      root: {
        ...flags,
        id: 'root',
        path: '',
        module: '/root.js',
        hasAction: false,
        hasLoader: false,
      },
      ...Object.fromEntries(
        routes.map((route) => [
          route.id,
          {
            ...flags,
            id: route.id,
            parentId: route.parentId,
            path: route.path,
            index: route.index,
            module: `/${route.id}.js`,
            hasAction: 'action' in modules[route.id],
            hasLoader: 'loader' in modules[route.id],
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
    root: {
      id: 'root',
      path: '',
      module: {
        default: () =>
          createElement(
            'html',
            null,
            createElement('body', null, createElement(Outlet)),
          ),
      },
    },
    ...Object.fromEntries(
      routes.map((route) => [
        route.id,
        {
          id: route.id,
          parentId: route.parentId,
          path: route.path,
          index: route.index,
          module: modules[route.id],
        },
      ]),
    ),
  },
}
const handler = createRequestHandler(build, 'production')

/** The loads the server answered, in order. */
let served: URL[] = []
function serve(request: Request, viewer: string) {
  if (request.method === 'GET') served.push(new URL(request.url))
  return handler(request, signedIn(viewer))
}

/**
 * A browser router on `path` whose loads and submissions travel through the
 * router's Single Fetch client to the request handler. It starts with the
 * full data load a client navigation to the page makes.
 */
async function browserAt(path: string, viewer: string) {
  const clientModules: UNSAFE_RouteModules = {
    root: { default: Outlet },
    ...Object.fromEntries(
      routes.map((route) => [
        route.id,
        {
          default: Outlet,
          shouldRevalidate: {
            [SHELL]: settingsLayout.shouldRevalidate,
            [BILLING]: billing.shouldRevalidate,
          }[route.id],
        },
      ]),
    ),
  }
  let router: DataRouter | undefined
  const singleFetch = UNSAFE_getTurboStreamSingleFetchDataStrategy(
    () => {
      if (!router) throw new Error('router not ready')
      return router
    },
    build.assets,
    clientModules,
    true,
    (request) => serve(request, viewer),
  )
  const ready = createMemoryRouter(
    UNSAFE_createClientRoutes(
      build.assets.routes,
      clientModules,
      null,
      true,
      false,
    ),
    // The router starts outside Settings, where nothing loads, and navigates
    // in: the first load of a hydrated page is its document, not Single Fetch.
    { initialEntries: ['/elsewhere'], dataStrategy: singleFetch },
  )
  router = ready
  await ready.navigate(path)
  expect(ready.state.location.pathname).toBe(path)
  expect(ready.state.errors).toBeNull()
  return ready
}

/**
 * Submits a form with `intent` from the page, as a fetcher does, and waits
 * for the revalidation that follows. Reads are counted from here on.
 */
async function submitFrom(
  router: DataRouter,
  routeId: string,
  href: string,
  intent: string,
) {
  reads.queries = []
  served = []
  joined.mockClear()
  const formData = new FormData()
  formData.set('intent', intent)
  await router.fetch('submission', routeId, href, {
    formMethod: 'post',
    formData,
  })
  await vi.waitFor(() => {
    expect(router.state.fetchers.get('submission')?.state ?? 'idle').toBe(
      'idle',
    )
    expect(router.state.revalidation).toBe('idle')
  })
  // The one revalidation the client sent after the submission.
  expect(served).toHaveLength(1)
  return served[0]
}

function member(id: string, role: string, status = 'active') {
  seedUser(fixture.sqlite, id)
  fixture.sqlite
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, status, created_at, updated_at)
       VALUES ('ws1', ?, ?, ?, '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z')`,
    )
    .run(id, role, status)
}

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM workspace_members; DELETE FROM users; DELETE FROM workspaces',
  )
  seedWorkspace(fixture.sqlite)
  fixture.sqlite
    .prepare(
      `UPDATE workspaces SET plan = 'plus', stripe_subscription_status = 'active',
         stripe_subscription_id = 'sub_1', external_posting_enabled = 1`,
    )
    .run()
  member('owner', 'owner')
  member('admin', 'admin')
  member('former', 'admin', 'removed')
  reads.queries = []
  served = []
  policyReads.mockReset()
  joined.mockClear()
})

test('members and the shell share one workspace, role and joined-project read', async () => {
  const router = await browserAt('/settings', 'owner')
  expect(router.state.loaderData[SHELL]).toMatchObject({
    currentUserRole: 'owner',
    kind: 'upgrade',
  })
  expect(router.state.loaderData[MEMBERS]).toMatchObject({
    membersPage: { total: 2 },
  })
  expect(workspaceReads()).toBe(1)
  expect(viewerMembershipReads('owner')).toBe(1)
  expect(joined).toHaveBeenCalledTimes(1)
})

test('the admin gate, the shell and bots share one role read', async () => {
  await browserAt('/settings/bots', 'admin')
  expect(workspaceReads()).toBe(1)
  expect(viewerMembershipReads('admin')).toBe(1)
  expect(joined).toHaveBeenCalledTimes(1)
})

test('paid billing shares the shell reads and computes one projection for both views', async () => {
  const projection = vi
    .spyOn(billingUsage, 'loadCurrentMonthOverageProjection')
    .mockResolvedValue({
      projectedOverageGb: 3,
      projectedOverageUsd: 0.3,
      projectedOverageJpy: 48,
    })
  const router = await browserAt('/settings/billing', 'owner')
  const shell = router.state.loaderData[SHELL]
  const page = router.state.loaderData[BILLING]
  expect(workspaceReads()).toBe(1)
  expect(viewerMembershipReads('owner')).toBe(1)
  expect(joined).toHaveBeenCalledTimes(1)
  expect(projection).toHaveBeenCalledTimes(1)
  // Plan and storage reach the page through the outlet, not this payload.
  for (const shellField of ['plan', 'storageUsedBytes', 'storageQuotaBytes'])
    expect(page).not.toHaveProperty(shellField)
  expect(page.overageProjection).toEqual({
    gb: 3,
    currency: 'usd',
    amount: 0.3,
  })
  expect(page.monthlyEstimate).toMatchObject({
    overageGb: 3,
    overageAmount: 0.3,
  })
  // The shell carries display fields only; billing keeps its own.
  expect(Object.keys(shell.workspace).sort()).toEqual([
    'hd',
    'id',
    'name',
    'plan',
    'storageQuotaBytes',
    'storageUsedBytes',
  ])
  const serialized = JSON.stringify(shell)
  for (const withheld of [
    'stripe',
    'sub_1',
    'policy',
    'billingConfigured',
    'hasSubscription',
    'contract',
    'monthlyEstimate',
    'botCreationEnabled',
    'linkSharingEnabled',
  ])
    expect(serialized).not.toContain(withheld)
  expect(page).toMatchObject({
    canManage: true,
    contract,
    externalPostingEnabled: true,
    billingConfigured: true,
    hasSubscription: true,
    stripeSubscriptionStatus: 'active',
  })
})

test.each(['admin', 'former', 'owner without active membership'])(
  'billing for %s keeps the read-only fields without owner data',
  async (viewer) => {
    if (viewer.startsWith('owner'))
      fixture.sqlite
        .prepare(
          `UPDATE workspace_members SET status = 'removed' WHERE user_id = 'owner'`,
        )
        .run()
    const router = await browserAt('/settings/billing', viewer.split(' ')[0])
    expect(router.state.loaderData[BILLING]).toMatchObject({
      canManage: false,
      contract: null,
      monthlyEstimate: null,
      billingConfigured: true,
      hasSubscription: true,
      stripeSubscriptionStatus: 'active',
      externalPostingEnabled: true,
      showOverageProjection: true,
    })
  },
)

test.each([
  ['admin', true],
  ['former', false],
] as const)(
  'removed members reach %s only as an active admin, on a full load and a members-only revalidation',
  async (viewer, admitted) => {
    member('gone', 'member', 'removed')
    fixture.sqlite
      .prepare(
        `UPDATE workspace_members SET removed_at = '2026-05-27T00:00:00.000Z' WHERE user_id = 'gone'`,
      )
      .run()
    const router = await browserAt('/settings', viewer)
    const removed = () =>
      router.state.loaderData[MEMBERS].removedMembers.length > 0
    expect(removed()).toBe(admitted)
    // One authorization lookup of the viewer's active membership.
    expect(viewerMembershipReads(viewer)).toBe(1)

    // A shell-neutral submission revalidates the members page alone.
    const revalidation = await submitFrom(
      router,
      MEMBERS,
      '/settings?index',
      'transfer-removed-assets',
    )
    expect(revalidation?.searchParams.get('_routes')).toBe(MEMBERS)
    expect(removed()).toBe(admitted)
    expect(workspaceReads()).toBe(0)
    expect(joined).not.toHaveBeenCalled()
    // Its fresh authorization is the shared admin query.
    expect(viewerMembershipReads(viewer)).toBe(1)
    expect(
      reads.queries.filter(
        ({ sql, parameters }) =>
          /\bfrom "workspace_members"/.test(sql) &&
          /"role" in \(\?, \?\)/.test(sql) &&
          parameters.includes(viewer),
      ),
    ).toHaveLength(1)
  },
)

test('a full external-access load takes its policy from the shell read', async () => {
  fixture.sqlite
    .prepare(
      `UPDATE workspaces SET link_sharing_enabled = 1, link_expiry_default_days = 14, link_expiry_max_days = 60`,
    )
    .run()
  const router = await browserAt('/settings/external-access', 'owner')
  expect(router.state.loaderData[EXTERNAL_ACCESS].policy).toEqual({
    plan: 'plus',
    linkSharingEnabled: true,
    externalPostingEnabled: true,
    linkExpiryDefaultDays: 14,
    linkExpiryMaxDays: 60,
  })
  expect(workspaceReads()).toBe(1)
  expect(policyReads).not.toHaveBeenCalled()
})

test('a document whose query names only the page still shares the shell reads', async () => {
  // A document runs every matched loader whatever its query says, so the
  // pages must share the shell's reads.
  const only = (id: string) => `?_routes=${encodeURIComponent(id)}`
  const external = await serve(
    new Request(
      `https://example.test/settings/external-access${only(EXTERNAL_ACCESS)}`,
    ),
    'owner',
  )
  expect(external.status).toBe(200)
  expect(workspaceReads()).toBe(1)
  expect(policyReads).not.toHaveBeenCalled()

  reads.queries = []
  const membersDocument = await serve(
    new Request(`https://example.test/settings${only(MEMBERS)}`),
    'owner',
  )
  expect(membersDocument.status).toBe(200)
  expect(viewerMembershipReads('owner')).toBe(1)
})

test('an external-access policy refresh on its own uses the feature reader', async () => {
  const router = await browserAt('/settings/external-access', 'owner')
  const policy = {
    plan: 'plus' as const,
    linkSharingEnabled: true,
    externalPostingEnabled: true,
    linkExpiryDefaultDays: 14,
    linkExpiryMaxDays: 60,
  }
  policyReads.mockResolvedValue(policy)
  const revalidation = await submitFrom(
    router,
    EXTERNAL_ACCESS,
    '/settings/external-access',
    'preview-external-access',
  )
  expect(revalidation?.searchParams.get('_routes')).toBe(EXTERNAL_ACCESS)
  expect(router.state.loaderData[EXTERNAL_ACCESS].policy).toEqual(policy)
  expect(policyReads).toHaveBeenCalledTimes(1)
  // No shell, membership or navigation read rides along.
  expect(workspaceReads()).toBe(0)
  expect(viewerMembershipReads('owner')).toBe(0)
  expect(joined).not.toHaveBeenCalled()
})
