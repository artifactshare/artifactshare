import {
  autoRoutes,
  type RouteConfig as RouteConfigEntry,
} from 'react-router-auto-routes'

const TEST_ROUTE_FILES = '**/*.test.{ts,tsx}'

export const DEVELOPMENT_ROUTE_FILES = [
  'api.poc.slack.events.tsx',
  'dev.gallery/**',
  'dev.scenarios.$scenario/**',
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

export function discoverRoutes(includeDevelopmentRoutes: boolean) {
  return arrangeSettingsRoutes(
    autoRoutes({
      ignoredRouteFiles: [
        TEST_ROUTE_FILES,
        ...(includeDevelopmentRoutes ? [] : DEVELOPMENT_ROUTE_FILES),
      ],
    }),
  )
}

export default discoverRoutes(
  process.env.ARTIFACTSHARE_INCLUDE_DEV_ROUTES === '1',
)
