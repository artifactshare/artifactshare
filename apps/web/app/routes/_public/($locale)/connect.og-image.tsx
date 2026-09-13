import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { fetchConnectOgImage } from '~/services/og-image-worker.server'
import type { Route } from './+types/connect.og-image'

export function loader({ params }: Route.LoaderArgs) {
  return fetchConnectOgImage(resolvePublicRouteLocale(params.locale))
}
