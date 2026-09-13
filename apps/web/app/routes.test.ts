import { describe, expect, test } from 'vitest'
import { discoverRoutes } from './routes'

type RouteEntry = ReturnType<typeof discoverRoutes>[number]

function flatten(routes: RouteEntry[]): RouteEntry[] {
  return routes.flatMap((route) => [route, ...flatten(route.children ?? [])])
}

describe('route discovery', () => {
  test('keeps development routes available to the local dev server', () => {
    const routes = flatten(discoverRoutes(true))

    expect(routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'routes/dev.gallery/index',
          path: 'dev/gallery',
        }),
        expect.objectContaining({
          id: 'routes/dev.scenarios.$scenario/index',
          path: 'dev/scenarios/:scenario',
        }),
        expect.objectContaining({
          id: 'routes/dev.sign-in',
          path: 'dev/sign-in',
        }),
        expect.objectContaining({
          id: 'routes/poc.static-site',
          path: 'poc/static-site',
        }),
        expect.objectContaining({
          id: 'routes/api.poc.slack.events',
          path: 'api/poc/slack/events',
        }),
      ]),
    )
  })

  test('omits development modules while retaining production routes', () => {
    const routes = flatten(discoverRoutes(false))
    const routeIds = routes.map((route) => route.id)

    expect(routeIds).toContain('routes/about')
    expect(
      routeIds.filter((id) => /^routes\/(?:dev|(?:api\.)?poc)\./u.test(id)),
    ).toEqual([])
  })
})
