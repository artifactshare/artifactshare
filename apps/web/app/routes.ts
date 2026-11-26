import {
  autoRoutes,
  type RouteConfig as RouteConfigEntry,
} from 'react-router-auto-routes'

const TEST_ROUTE_FILES = '**/*.test.{ts,tsx}'

export const DEVELOPMENT_ROUTE_FILES = [
  'api.poc.slack.events.tsx',
  'dev.gallery/**',
  'dev.scenarios.$scenario/**',
  'dev.screens.tsx',
  'dev.settings.$state/**',
  'dev.sign-in.tsx',
  'poc.static-site.tsx',
] as const

const SETTINGS = 'routes/_protected/settings'

/** Settings pages that only workspace admins may open, gated together. */
const SETTINGS_ADMIN_PAGES = [
  `${SETTINGS}/_content/bots`,
  `${SETTINGS}/_content/activity`,
  `${SETTINGS}/_content/inventory/_layout`,
]

/**
 * Resources only a Settings confirmation fetches. They answer 401 instead of
 * redirecting to sign-in, so they sit outside the document authentication and
 * the Settings shell, at the same URLs.
 */
const SETTINGS_CONFIRMATION_RESOURCES = [
  `${SETTINGS}/recipients`,
  `${SETTINGS}/billing-preview`,
]

function findRoute(
  routes: RouteConfigEntry[],
  id: string,
): RouteConfigEntry | undefined {
  for (const route of routes) {
    if (route.id === id) return route
    const child = findRoute(route.children ?? [], id)
    if (child) return child
  }
  return undefined
}

function takeChildren(parent: RouteConfigEntry, ids: string[]) {
  const children = parent.children ?? []
  const taken = ids.map((id) => {
    const child = children.find((route) => route.id === id)
    if (!child) throw new Error(`route ${id} is not a child of ${parent.id}`)
    return child
  })
  const moved = new Set(ids)
  parent.children = children.filter((route) => !moved.has(route.id))
  return taken
}

/**
 * Settings ancestry the file layout cannot express while keeping every
 * module's source path, route ID and URL.
 */
export function arrangeSettingsRoutes(routes: RouteConfigEntry[]) {
  const shell = findRoute(routes, `${SETTINGS}/_layout`)
  const content = findRoute(routes, `${SETTINGS}/_content/_layout`)
  if (!shell || !content) throw new Error('Settings routes are missing')
  const adminPages = takeChildren(content, SETTINGS_ADMIN_PAGES)
  content.children = [
    ...(content.children ?? []),
    {
      id: `${SETTINGS}/_content/_admin`,
      file: `${SETTINGS}/_content/+admin/_layout.tsx`,
      children: adminPages,
    },
  ]
  const resources = takeChildren(shell, SETTINGS_CONFIRMATION_RESOURCES).map(
    (route) => ({ ...route, path: `settings/${route.path}` }),
  )
  return [...routes, ...resources]
}

const PROTECTED = 'routes/_protected/_layout'
const HOME_LISTS = 'routes/_home/_protected/_layout'

/** The signed-in pages that share the header and the bottom tab bar. */
const APP_SHELL_PAGES = [
  'routes/_protected/settings/_layout',
  'routes/_protected/projects.archived',
  'routes/_protected/projects.$id',
  'routes/_protected/projects.$id.activity',
  'routes/_protected/projects.$id.files',
]

/**
 * Puts Home's lists, Settings and the project pages under one shell, so the
 * header and its joined projects are read once for all of them and stay put
 * while moving between them. The signed-in `/` sits in the public locale tree
 * and renders the same shell from its own layout. Every module keeps its
 * source path, route ID and URL.
 */
export function arrangeAppShellRoutes(routes: RouteConfigEntry[]) {
  const homeLists = routes.find((route) => route.id === HOME_LISTS)
  const protectedLayout = routes.find((route) => route.id === PROTECTED)
  if (!homeLists || !protectedLayout) {
    throw new Error('App shell routes are missing')
  }
  const pages = takeChildren(protectedLayout, APP_SHELL_PAGES)
  protectedLayout.children = [
    {
      id: 'routes/_protected/_shell',
      file: 'routes/_protected/+shell/_layout.tsx',
      children: [homeLists, ...pages],
    },
    ...(protectedLayout.children ?? []),
  ]
  return routes.filter((route) => route !== homeLists)
}

export function discoverRoutes(includeDevelopmentRoutes: boolean) {
  return arrangeAppShellRoutes(
    arrangeSettingsRoutes(
      autoRoutes({
        ignoredRouteFiles: [
          TEST_ROUTE_FILES,
          ...(includeDevelopmentRoutes ? [] : DEVELOPMENT_ROUTE_FILES),
        ],
      }),
    ),
  )
}

export default discoverRoutes(
  process.env.ARTIFACTSHARE_INCLUDE_DEV_ROUTES === '1',
)
