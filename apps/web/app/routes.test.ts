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
    'resolves migrated public pages and resources through the optional locale layout (development: %s)',
    (includeDevelopmentRoutes) => {
      const routes = discoverRoutes(includeDevelopmentRoutes)
      const routeIds = flatten(routes).map((route) => route.id)

      for (const page of [
        'about',
        'connect',
        'connect.og-image',
        'og-image',
        'pricing',
        'privacy',
        'share-with-ai',
        'start',
        'terms',
        'tokushoho',
      ]) {
        expect(routeIds).not.toContain(`routes/ja.${page}`)
        for (const prefix of ['', '/ja']) {
          const matches = matchRoutes(
            routes.map(toRouteObject),
            `${prefix}/${page.replaceAll('.', '/')}`,
          )
          expect(matches?.at(-1)?.route.id).toBe(
            `routes/_public/($locale)/${page}`,
          )
          expect(matches?.at(-1)?.params.locale).toBe(prefix ? 'ja' : undefined)
        }
      }

      for (const [path, routeId] of [
        ['updates', 'updates'],
        ['updates/:slug', 'updates.$slug'],
        ['updates/:slug/og-image', 'updates.$slug.og-image'],
      ] as const) {
        for (const prefix of ['', 'ja']) {
          const matches = matchRoutes(
            routes.map(toRouteObject),
            `/${prefix ? `${prefix}/` : ''}${path}`,
          )
          expect(matches?.at(-1)?.route.id).toBe(
            `routes/_public/($locale)/${routeId}`,
          )
          expect(matches?.at(-1)?.params.locale).toBe(prefix || undefined)
        }
      }

      expect(routeIds).not.toContain('routes/ja.updates')
      expect(routeIds).not.toContain('routes/ja.updates.$slug')
      expect(routeIds).not.toContain('routes/ja.updates.$slug.og-image')
    },
  )

  test.each([true, false])(
    'resolves the landing URL pair through the optional locale home route (development: %s)',
    (includeDevelopmentRoutes) => {
      const routes = discoverRoutes(includeDevelopmentRoutes)
      const routeIds = flatten(routes).map((route) => route.id)

      expect(routeIds).not.toContain('routes/_home/index')
      expect(routeIds).not.toContain('routes/ja')
      for (const path of ['/', '/ja']) {
        const matches = matchRoutes(routes.map(toRouteObject), path)
        expect(matches?.at(-1)?.route.id).toBe(
          'routes/_public/($locale)/_home/index',
        )
        expect(matches?.at(-1)?.params.locale).toBe(
          path === '/ja' ? 'ja' : undefined,
        )
      }
    },
  )

  test.each([true, false])(
    'keeps the published viewer test fixture out of runtime routes (development: %s)',
    (includeDevelopmentRoutes) => {
      const routes = discoverRoutes(includeDevelopmentRoutes)
      const routeIds = flatten(routes).map((route) => route.id)

      expect(routeIds).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining('published-viewer-loader-fixture'),
        ]),
      )
      expect(
        matchRoutes(routes.map(toRouteObject), '/a/abc123def4')?.at(-1)?.route
          .id,
      ).toBe('routes/a.$id/index')
    },
  )

  test('removes duplicate root and Japanese wrappers for migrated resources', () => {
    const routeIds = flatten(discoverRoutes(false)).map((route) => route.id)
    expect(routeIds).not.toContain('routes/og-image')
    expect(routeIds).not.toContain('routes/ja.og-image')
    expect(routeIds).not.toContain('routes/share-with-ai')
    expect(routeIds).not.toContain('routes/ja.share-with-ai')
  })

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

test('settings page URLs share a content boundary and resource URLs belong to the shell', () => {
  const routes = discoverRoutes(false).map(toRouteObject)
  const settings = 'routes/_protected/settings'
  for (const page of [
    'index',
    'activity',
    'analytics',
    'billing',
    'bots',
    'general',
    'integrations',
    'external-access',
    'tokens',
    'inventory/index',
    'inventory/projects',
    'inventory/artifacts',
    'billing-preview',
    'cli-sessions',
    'usage',
    'recipients',
  ]) {
    const resource = [
      'billing-preview',
      'cli-sessions',
      'usage',
      'recipients',
    ].includes(page)
    const matches = matchRoutes(
      routes,
      '/settings/' + page.replace(/index$/, ''),
    )
    const ids = matches?.map((match) => match.route.id)
    expect(ids).toContain(settings + '/_layout')
    expect(ids?.includes(settings + '/_content/_layout')).toBe(!resource)
    expect(ids?.at(-1)).toBe(settings + (resource ? '/' : '/_content/') + page)
    expect(Boolean(matches?.at(-1)?.route.index)).toBe(page.endsWith('index'))
  }
})
