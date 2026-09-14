import { autoRoutes } from 'react-router-auto-routes'

const TEST_ROUTE_FILES = '**/*.test.{ts,tsx}'

export const DEVELOPMENT_ROUTE_FILES = [
  'api.poc.slack.events.tsx',
  'dev.gallery/**',
  'dev.scenarios.$scenario/**',
  'dev.sign-in.tsx',
  'poc.static-site.tsx',
] as const

export function discoverRoutes(includeDevelopmentRoutes: boolean) {
  return autoRoutes({
    ignoredRouteFiles: [
      TEST_ROUTE_FILES,
      ...(includeDevelopmentRoutes ? [] : DEVELOPMENT_ROUTE_FILES),
    ],
  })
}

export default discoverRoutes(
  process.env.ARTIFACTSHARE_INCLUDE_DEV_ROUTES === '1',
)
