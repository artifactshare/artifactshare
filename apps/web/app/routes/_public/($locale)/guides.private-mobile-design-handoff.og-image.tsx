import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { fetchPrivateMobileDesignHandoffOgImage } from '~/services/og-image-worker.server'
import type { Route } from './+types/guides.private-mobile-design-handoff.og-image'

export function loader({ params }: Route.LoaderArgs) {
  return fetchPrivateMobileDesignHandoffOgImage(
    resolvePublicRouteLocale(params.locale),
  )
}
