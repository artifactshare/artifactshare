import { matchRoutes, type RouteObject } from 'react-router'
import { discoverRoutes } from '~/routes'

type RouteEntry = ReturnType<typeof discoverRoutes>[number]

function toRouteObject({ id, path, index, children }: RouteEntry): RouteObject {
  return index
    ? { id, path, index: true }
    : { id, path, children: children?.map(toRouteObject) }
}

/** The discovered route tree in the shape `matchRoutes` takes. */
export function discoveredRoutes(includeDevelopmentRoutes = false) {
  return discoverRoutes(includeDevelopmentRoutes).map(toRouteObject)
}

/**
 * What a URL resolves to. A route's id is the path of the file that declares
 * it, so folding a route into a folder (`x.tsx` → `x/index.tsx`) renames it
 * while serving the same URL: tests compare the URL a request lands on and
 * the layouts above it, which carry the authentication boundaries.
 */
export function resolveRoute(routes: RouteObject[], url: string) {
  const matches = matchRoutes(routes, url)
  const leaf = matches?.at(-1)
  return {
    layouts: matches?.slice(0, -1).map((match) => match.route.id),
    ids: matches?.map((match) => match.route.id),
    leafPath: leaf?.route.path,
    isIndex: Boolean((leaf?.route as RouteObject | undefined)?.index),
    params: leaf?.params ?? {},
    resolved: leaf?.pathname,
  }
}
