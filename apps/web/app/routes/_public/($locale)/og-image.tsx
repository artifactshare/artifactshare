import { fetchHomeOgImage } from '~/services/og-image-worker.server'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import type { Route } from './+types/og-image'

// The home (apex) Open Graph card. One static image per locale, so it caches
// hard at the edge — Open Graph scrapers (Slack, X, …) fetch it occasionally.
export function loader({ params }: Route.LoaderArgs) {
  return fetchHomeOgImage(resolvePublicRouteLocale(params.locale))
}
