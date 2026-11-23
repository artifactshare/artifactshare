// Bots, activity and inventory refuse a non-admin the same way, through the
// real route topology, middleware and request handler: a 403 that the Settings
// content boundary shows at the requested URL, without the page's data.
import { renderToStaticMarkup } from 'react-dom/server'
import {
  createRequestHandler,
  MemoryRouter,
  Outlet,
  RouterContextProvider,
  Scripts,
  UNSAFE_decodeViaTurboStream,
  UNSAFE_withComponentProps,
  UNSAFE_withErrorBoundaryProps,
  type LoaderFunctionArgs,
  type ServerBuild,
} from 'react-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import * as entry from '~/entry.server'
import { bindI18n } from '~/lib/i18n'
import { userContext } from '~/middleware/context'
import { discoverRoutes } from '~/routes'
import { seedUser, seedWorkspace } from '~/test/db-seed-fixture'
import { createMigratedInMemoryDb } from '~/test/sqlite-fixture'
import * as protectedLayout from '../_layout'
import * as settingsLayout from './_layout'
import * as content from './_content/_layout'
import * as admin from './_content/+admin/_layout'
import * as bots from './_content/bots'
import * as activity from './_content/activity'
import * as inventory from './_content/inventory/_layout'
import * as inventoryIndex from './_content/inventory/index'
import * as inventoryProjects from './_content/inventory/projects'
import * as inventoryArtifacts from './_content/inventory/artifacts'
import { SettingsNavigation } from './+components/settings-nav'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/services/db.server', () => ({ createDb: () => fixture.db }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n('en') }))
vi.mock('~/lib/bot-members-flag.server', () => ({
  isBotMembersEnabled: async () => true,
}))
const botService = vi.hoisted(() => ({
  listWorkspaceBots: vi.fn(async () => [{ id: 'bot-1', name: 'Nightly' }]),
  reissue: vi.fn(async () => ({ kind: 'ok' as const, token: 'bot-secret' })),
}))
vi.mock('~/services/bot-members.server', () => ({
  listWorkspaceBots: botService.listWorkspaceBots,
  reissueWorkspaceBotCredential: botService.reissue,
  cancelWorkspaceBot: vi.fn(),
  createWorkspaceBot: vi.fn(),
  stopWorkspaceBot: vi.fn(),
}))
vi.mock('~/services/project-membership.server', () => ({
  listJoinedProjectsForDropdown: async () => [],
}))
// The shared chrome is not what this checks.
vi.mock('../../_home/+components/topbar', () => ({ Topbar: () => null }))
vi.mock('../../_home/+components/bottom-tab-bar', () => ({
  BottomTabBar: () => null,
}))

const fixture = createMigratedInMemoryDb()

type RouteModule = NonNullable<ServerBuild['routes'][string]>['module']

// The framework build hands each route its typed arguments and component
// props; these wrappers do the same for the real modules.
const at = (pattern: string, args: LoaderFunctionArgs) => ({
  ...args,
  params: {},
  pattern,
  url: new URL(args.request.url),
})
const asPage = UNSAFE_withComponentProps

const SETTINGS = 'routes/_protected/settings'
const modules: Record<string, RouteModule> = {
  'routes/_protected/_layout': {
    middleware: protectedLayout.middleware,
    default: asPage(protectedLayout.default),
  },
  [`${SETTINGS}/_layout`]: {
    loader: (args) => settingsLayout.loader(at('/settings', args)),
    default: asPage(settingsLayout.default),
  },
  [`${SETTINGS}/_content/_layout`]: {
    default: asPage(content.default),
    ErrorBoundary: UNSAFE_withErrorBoundaryProps(content.ErrorBoundary),
  },
  [`${SETTINGS}/_content/_admin`]: {
    middleware: admin.middleware,
    default: asPage(admin.default),
  },
  [`${SETTINGS}/_content/bots`]: {
    loader: (args) => bots.loader(at('/settings/bots', args)),
    action: (args) => bots.action(at('/settings/bots', args)),
    default: asPage(bots.default),
  },
  [`${SETTINGS}/_content/activity`]: {
    loader: (args) => activity.loader(at('/settings/activity', args)),
    default: asPage(activity.default),
  },
  [`${SETTINGS}/_content/inventory/_layout`]: {
    default: asPage(inventory.default),
  },
  [`${SETTINGS}/_content/inventory/index`]: {
    loader: (args) => inventoryIndex.loader(at('/settings/inventory', args)),
    default: asPage(inventoryIndex.default),
  },
  [`${SETTINGS}/_content/inventory/projects`]: {
    loader: (args) =>
      inventoryProjects.loader(at('/settings/inventory/projects', args)),
    default: asPage(inventoryProjects.default),
  },
  [`${SETTINGS}/_content/inventory/artifacts`]: {
    loader: (args) =>
      inventoryArtifacts.loader(at('/settings/inventory/artifacts', args)),
    default: asPage(inventoryArtifacts.default),
  },
}

type Entry = ReturnType<typeof discoverRoutes>[number]
function placed(
  routes: Entry[],
  parentId = 'root',
): Array<
  Entry & {
    parentId: string
  }
> {
  return routes.flatMap((route) => [
    { ...route, parentId },
    ...placed(route.children ?? [], route.id),
  ])
}

/** The production route tree, limited to the Settings admin pages. */
function settingsServer() {
  const routes = placed(discoverRoutes(false)).filter(
    (route) => route.id in modules,
  )
  expect(routes.map((route) => route.id).sort()).toEqual(
    Object.keys(modules).sort(),
  )
  function Root() {
    return (
      <html lang="en">
        <body>
          <Outlet />
          {/* Streams the loader data the browser hydrates, as root.tsx does. */}
          <Scripts />
        </body>
      </html>
    )
  }
  const flags = {
    hasClientAction: false,
    hasClientLoader: false,
    hasClientMiddleware: false,
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
      version: 'settings-admin-gate',
      routes: {
        root: {
          ...flags,
          id: 'root',
          path: '',
          module: '/root.js',
          hasAction: false,
          hasLoader: false,
          hasErrorBoundary: false,
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
              hasErrorBoundary: 'ErrorBoundary' in modules[route.id],
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
      root: { id: 'root', path: '', module: { default: Root } },
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
  return (request: Request, viewer: string) => {
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
    return handler(request, context)
  }
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

function setPlan(plan: string) {
  fixture.sqlite.prepare(`UPDATE workspaces SET plan = ?`).run(plan)
}

const guardedPages = [
  '/settings/bots',
  '/settings/activity',
  '/settings/inventory',
  '/settings/inventory/projects',
  '/settings/inventory/artifacts',
]

beforeEach(() => {
  fixture.sqlite.exec(
    'DELETE FROM audit_events; DELETE FROM artifact_containers; DELETE FROM workspace_members; DELETE FROM users; DELETE FROM workspaces',
  )
  seedWorkspace(fixture.sqlite)
  setPlan('team')
  member('owner', 'owner')
  member('admin', 'admin')
  member('member', 'member')
  member('former', 'admin', 'removed')
  // Data each guarded page would show an admin.
  fixture.sqlite.exec(`
    INSERT INTO artifact_containers (id, workspace_id, kind, name, created_at, updated_at)
      VALUES ('p1', 'ws1', 'project', 'Ledger Alpha', '2026-05-26T00:00:00.000Z', '2026-05-26T00:00:00.000Z');
    INSERT INTO audit_events (id, workspace_id, actor_user_id, action, subject_type, subject_id, detail, created_at)
      VALUES ('e1', 'ws1', 'owner', 'workspace.rename', 'workspace', 'ws1', '{"name":"Audit Beacon"}', '2026-05-26T00:00:00.000Z');
  `)
  botService.listWorkspaceBots.mockClear()
  botService.reissue.mockClear()
})

/** Values only an admin's bots, activity or inventory page contains. */
const protectedValues = [
  'Nightly',
  'botCreationEnabled',
  'Audit Beacon',
  'Ledger Alpha',
]

/** Keys only a guarded page's loader data carries. */
const withheldKeys = [
  'bots',
  'botCreationEnabled',
  'events',
  'total',
  'page',
  'projects',
  'artifacts',
  'filters',
]

/** The loader data a document streams to the browser for hydration. */
async function hydrationData(html: string) {
  const chunks = [
    ...html.matchAll(/streamController\.enqueue\(("(?:[^"\\]|\\.)*")\);/g),
  ].map(([, literal]) => {
    const chunk: unknown = JSON.parse(literal)
    if (typeof chunk !== 'string') throw new Error('unexpected stream chunk')
    return chunk
  })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
  const { value } = await UNSAFE_decodeViaTurboStream(stream, globalThis)
  if (!value || typeof value !== 'object' || !('loaderData' in value))
    throw new Error('missing hydration data')
  return { loaderData: value.loaderData }
}

/** Every object key anywhere in a decoded value. */
function keysIn(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysIn)
  if (!value || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, inner]) => [
    key,
    ...keysIn(inner),
  ])
}

/** The guarded matrix's viewers without an active admin membership. */
const refusedViewers = {
  member: 'member',
  'former admin': 'former',
  // The owner's membership is no longer active.
  'former owner': 'owner',
}

describe('a viewer who is not an active admin', () => {
  test.each(Object.entries(refusedViewers))(
    '%s gets the Settings 403 at every guarded URL',
    async (label, viewer) => {
      if (label === 'former owner')
        fixture.sqlite.exec(
          `UPDATE workspace_members SET status = 'removed' WHERE user_id = 'owner'`,
        )
      const serve = settingsServer()
      for (const url of guardedPages) {
        const response = await serve(
          new Request(`https://example.test${url}`),
          viewer,
        )
        expect(response.status, url).toBe(403)
        expect(response.headers.get('Location'), url).toBeNull()
        const html = await response.text()
        expect(html, url).toContain(
          'data-screen-capture-error="settings-error-boundary"',
        )
        expect(html, url).toContain(bindI18n('en').t('settings.error.back'))
        expect(html, url).toContain(
          bindI18n('en').t('settings.error.forbidden.title'),
        )
        for (const value of protectedValues)
          expect(html, `${url} ${value}`).not.toContain(value)
        // The loader data the document hands to the browser.
        const hydrated = await hydrationData(html)
        for (const key of withheldKeys)
          expect(keysIn(hydrated.loaderData), `${url} ${key}`).not.toContain(
            key,
          )
      }
      expect(botService.listWorkspaceBots).not.toHaveBeenCalled()
    },
  )

  test('a selective data request for a guarded page gets the 403 without its data', async () => {
    const serve = settingsServer()
    for (const [url, routeId] of [
      ['/settings/bots', `${SETTINGS}/_content/bots`],
      ['/settings/activity', `${SETTINGS}/_content/activity`],
      [
        '/settings/inventory/projects',
        `${SETTINGS}/_content/inventory/projects`,
      ],
      [
        '/settings/inventory/artifacts',
        `${SETTINGS}/_content/inventory/artifacts`,
      ],
    ]) {
      const response = await serve(
        new Request(`https://example.test${url}.data?_routes=${routeId}`),
        'member',
      )
      if (!response.body) throw new Error('missing data response')
      const decoded = await UNSAFE_decodeViaTurboStream(
        response.body,
        globalThis,
      )
      expect(decoded.value, url).toEqual({
        [routeId]: { error: expect.objectContaining({ status: 403 }) },
      })
    }
    expect(botService.listWorkspaceBots).not.toHaveBeenCalled()
  })

  test('a direct JSON reissue to bots is refused before any mutation', async () => {
    const response = await settingsServer()(
      new Request('https://example.test/settings/bots.data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'reissue', botUserId: 'bot-1' }),
      }),
      'member',
    )
    expect(response.status).toBe(403)
    expect(response.headers.get('Location')).toBeNull()
    if (!response.body) throw new Error('missing action result')
    const decoded = await UNSAFE_decodeViaTurboStream(response.body, globalThis)
    // A route-level 403, not the bots service's own action result.
    expect(decoded.value).toEqual({
      error: expect.objectContaining({ status: 403 }),
    })
    expect(JSON.stringify(decoded.value)).not.toContain('bot-secret')
    expect(botService.reissue).not.toHaveBeenCalled()
  })
})

describe('an eligible Team admin', () => {
  test.each(['owner', 'admin'])(
    '%s reads every guarded page and the inventory index redirect',
    async (viewer) => {
      const serve = settingsServer()
      for (const url of guardedPages) {
        const response = await serve(
          new Request(`https://example.test${url}`),
          viewer,
        )
        if (url === '/settings/inventory') {
          expect(response.status).toBe(302)
          expect(response.headers.get('Location')).toBe(
            '/settings/inventory/projects',
          )
          continue
        }
        expect(response.status, url).toBe(200)
        const html = await response.text()
        expect(html, url).not.toContain('settings-error-boundary')
        // The healthy control shows the data the refusals withhold.
        const shown = {
          '/settings/bots': 'Nightly',
          '/settings/inventory/projects': 'Ledger Alpha',
        }[url]
        if (shown) expect(html, url).toContain(shown)
        // The healthy control hands the browser the keys refusals withhold.
        const expectedKeys = {
          '/settings/bots': ['bots', 'botCreationEnabled'],
          '/settings/activity': ['events', 'total', 'page'],
          '/settings/inventory/projects': ['projects', 'total', 'page'],
          '/settings/inventory/artifacts': ['artifacts', 'filters'],
        }[url]
        const hydrated = keysIn((await hydrationData(html)).loaderData)
        for (const key of expectedKeys ?? [])
          expect(hydrated, `${url} ${key}`).toContain(key)
      }
      expect(botService.listWorkspaceBots).toHaveBeenCalled()
    },
  )

  test('an equivalent spelling of a guarded URL admits the admin too', async () => {
    const serve = settingsServer()
    for (const url of ['/Settings/Bots', '/settings/%62ots']) {
      const response = await serve(
        new Request(`https://example.test${url}`),
        'admin',
      )
      expect(response.status, url).toBe(200)
      expect(await response.text(), url).toContain('Nightly')
    }
  })

  test('reaches the bot credential reissue with the same submission', async () => {
    const response = await settingsServer()(
      new Request('https://example.test/settings/bots.data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intent: 'reissue', botUserId: 'bot-1' }),
      }),
      'owner',
    )
    expect(response.status).toBe(200)
    if (!response.body) throw new Error('missing action result')
    const decoded = await UNSAFE_decodeViaTurboStream(response.body, globalThis)
    expect(decoded.value).toEqual({
      data: { ok: true, code: 'ok', intent: 'reissue', token: 'bot-secret' },
    })
    expect(botService.reissue).toHaveBeenCalledWith(
      fixture.db,
      { id: 'owner', workspaceId: 'ws1' },
      'bot-1',
    )
  })
})

test('an admin outside the Team plan keeps the inventory redirect and its other admin pages', async () => {
  setPlan('plus')
  const serve = settingsServer()
  for (const url of [
    '/settings/inventory',
    '/settings/inventory/projects',
    '/settings/inventory/artifacts',
  ]) {
    const response = await serve(
      new Request(`https://example.test${url}`),
      'admin',
    )
    expect(response.status, url).toBe(302)
    expect(response.headers.get('Location'), url).toBe('/settings')
  }
  expect(
    (await serve(new Request('https://example.test/settings/bots'), 'admin'))
      .status,
  ).toBe(200)
})

test.each([
  [true, 'team', ['bots', 'activity', 'inventory']],
  [true, 'upgrade', ['bots', 'activity']],
  [false, 'team', []],
  [false, 'upgrade', []],
] as const)(
  'the menu lists the admin pages the gate admits (admin %s, %s)',
  (isAdmin, workspaceKind, listed) => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/settings/general']}>
        <SettingsNavigation
          pathname="/settings/general"
          currentUserIsAdmin={isAdmin}
          workspaceKind={workspaceKind}
        >
          {null}
        </SettingsNavigation>
      </MemoryRouter>,
    )
    for (const page of ['bots', 'activity', 'inventory'] as const)
      expect(html.includes(`href="/settings/${page}"`), page).toBe(
        (listed as readonly string[]).includes(page),
      )
  },
)
