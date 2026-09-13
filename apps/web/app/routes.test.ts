import { describe, expect, test } from 'vitest'
import { matchRoutes, type RouteObject } from 'react-router'
import { discoverRoutes } from './routes'

type RouteEntry = ReturnType<typeof discoverRoutes>[number]

function flatten(routes: RouteEntry[]): RouteEntry[] {
  return routes.flatMap((route) => [route, ...flatten(route.children ?? [])])
}

function toRouteObject({ id, path, index, children }: RouteEntry): RouteObject {
  return index
    ? { id, path, index: true }
    : { id, path, children: children?.map(toRouteObject) }
}

describe('route discovery', () => {
  test.each([true, false])(
    'resolves migrated public pages through the optional locale layout (development: %s)',
    (includeDevelopmentRoutes) => {
      const routes = discoverRoutes(includeDevelopmentRoutes)
      const routeIds = flatten(routes).map((route) => route.id)

      for (const page of [
        'about',
        'connect',
        'pricing',
        'privacy',
        'start',
        'terms',
        'tokushoho',
      ]) {
        expect(routeIds).not.toContain(`routes/ja.${page}`)
        for (const prefix of ['', '/ja']) {
          const matches = matchRoutes(
            routes.map(toRouteObject),
            `${prefix}/${page}`,
          )
          expect(matches?.at(-1)?.route.id).toBe(
            `routes/_public/($locale)/${page}`,
          )
          expect(matches?.at(-1)?.params.locale).toBe(prefix ? 'ja' : undefined)
        }
      }
    },
  )

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

    expect(routeIds).toContain('routes/_public/($locale)/about')
    expect(
      routeIds.filter((id) => /^routes\/(?:dev|(?:api\.)?poc)\./u.test(id)),
    ).toEqual([])
  })
})
