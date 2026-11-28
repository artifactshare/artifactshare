import { fetchHomeOgImage } from '~/services/og-image-worker.server'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import type { Route } from './+types/og-image'

export function loader({ params }: Route.LoaderArgs) {
  return fetchHomeOgImage(resolvePublicRouteLocale(params.locale))
}
