import { describe, expect, test } from 'vitest'
import { matchRoutes } from 'react-router'
import {
  discoveredRoutes,
  resolveRoute as resolve,
} from './test/discovered-routes'
import { discoverRoutes } from './routes'

type RouteEntry = ReturnType<typeof discoverRoutes>[number]

function flatten(routes: RouteEntry[]): RouteEntry[] {
  return routes.flatMap((route) => [route, ...flatten(route.children ?? [])])
}

const PUBLIC_LOCALE_LAYOUT = 'routes/_public/($locale)/_layout'

describe('route discovery', () => {
  test.each([true, false])(
    'serves every public page at both locale URLs from one route (development: %s)',
    (includeDevelopmentRoutes) => {
      const routes = discoveredRoutes(includeDevelopmentRoutes)

      for (const [page, url] of [
        ['about', 'about'],
        ['connect', 'connect'],
        ['connect.og-image', 'connect/og-image'],
        ['og-image', 'og-image'],
        ['pricing', 'pricing'],
        ['privacy', 'privacy'],
        ['share-with-ai', 'share-with-ai'],
        ['start', 'start'],
        ['terms', 'terms'],
        ['tokushoho', 'tokushoho'],
        ['updates', 'updates'],
        ['updates.$slug', 'updates/the-slug'],
        ['updates.$slug.og-image', 'updates/the-slug/og-image'],
      ] as const) {
        const english = resolve(routes, `/${url}`)
        const japanese = resolve(routes, `/ja/${url}`)

        expect(english.layouts, page).toContain(PUBLIC_LOCALE_LAYOUT)
        expect(english.resolved, page).toBe(`/${url}`)
        // One route answers both URLs, so there is no separate ja page.
        expect(japanese.ids, page).toEqual(english.ids)
        expect(english.params.locale, page).toBeUndefined()
        expect(japanese.params.locale, page).toBe('ja')
      }
    },
  )

  test.each([true, false])(
    'serves the landing URL pair from the locale home index (development: %s)',
    (includeDevelopmentRoutes) => {
      const routes = discoveredRoutes(includeDevelopmentRoutes)
      const english = resolve(routes, '/')
      const japanese = resolve(routes, '/ja')

      expect(english.layouts).toContain(PUBLIC_LOCALE_LAYOUT)
      expect(english.isIndex).toBe(true)
      expect(japanese.ids).toEqual(english.ids)
      expect(english.params.locale).toBeUndefined()
      expect(japanese.params.locale).toBe('ja')
    },
  )

  test.each([true, false])(
    'keeps the published viewer test fixture out of runtime routes (development: %s)',
    (includeDevelopmentRoutes) => {
      const routeIds = flatten(discoverRoutes(includeDevelopmentRoutes)).map(
        (route) => route.id,
      )

      expect(routeIds).not.toEqual(
        expect.arrayContaining([
          expect.stringContaining('published-viewer-loader-fixture'),
        ]),
      )
      const viewer = resolve(
        discoveredRoutes(includeDevelopmentRoutes),
        '/a/abc123def4',
      )
      expect(viewer.leafPath).toBe('a/:id')
      expect(viewer.params.id).toBe('abc123def4')
    },
  )

  test('keeps development routes available to the local dev server', () => {
    const routes = discoveredRoutes(true)

    for (const url of [
      '/dev/gallery',
      '/dev/scenarios/empty-home',
      '/dev/screens',
      '/dev/settings/team-past-due/billing',
      '/dev/sign-in',
      '/poc/static-site',
      '/api/poc/slack/events',
    ])
      expect(resolve(routes, url).resolved, url).toBe(url)
  })

  test('omits development modules while retaining production routes', () => {
    const routes = discoveredRoutes()
    const routeIds = flatten(discoverRoutes(false)).map((route) => route.id)

    expect(resolve(routes, '/about').resolved).toBe('/about')
    expect(
      routeIds.filter((id) => /^routes\/(?:dev|(?:api\.)?poc)\./u.test(id)),
    ).toEqual([])
    for (const url of [
      '/dev/gallery',
      '/dev/screens',
      '/dev/settings/team-past-due/billing',
      '/poc/static-site',
    ])
      expect(matchRoutes(routes, url), url).toBeNull()
  })
})

describe('settings route ancestry', () => {
  const routes = discoveredRoutes()
  const settings = 'routes/_protected/settings'

  test.each([
    ['', false],
    ['analytics', false],
    ['billing', false],
    ['general', false],
    ['integrations', false],
    ['external-access', false],
    ['tokens', false],
    ['bots', true],
    ['activity', true],
    ['inventory/', true],
    ['inventory/projects', true],
    ['inventory/artifacts', true],
  ])('page %s shares the content boundary (admin gate: %s)', (page, gated) => {
    const url = `/settings/${page}`
    const { layouts, resolved, isIndex } = resolve(routes, url)

    expect(resolved).toBe(url)
    expect(layouts).toContain('routes/_protected/_layout')
    expect(layouts).toContain(`${settings}/_layout`)
    expect(layouts).toContain(`${settings}/_content/_layout`)
    expect(layouts?.includes(`${settings}/_content/_admin`)).toBe(gated)
    expect(isIndex).toBe(page.endsWith('/') || page === '')
  })

  test.each(['cli-sessions', 'usage'])(
    'document redirect %s stays under document authentication, outside the shell',
    (page) => {
      const { layouts, resolved } = resolve(routes, `/settings/${page}`)

      expect(resolved).toBe(`/settings/${page}`)
      expect(layouts).toEqual([
        'routes/_protected/_layout',
        `${settings}/_layout`,
      ])
    },
  )

  test.each(['recipients', 'billing-preview'])(
    'confirmation resource %s keeps its URL outside document authentication and the shell',
    (page) => {
      const { layouts, resolved } = resolve(routes, `/settings/${page}`)

      expect(resolved).toBe(`/settings/${page}`)
      expect(layouts).toEqual([])
    },
  )
})
