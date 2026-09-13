import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { fetchUpdatesEntryOgImage } from '~/services/og-image-worker.server'
import { getVisibleUpdateBySlug } from '~/services/updates-visibility.server'
import type { Route } from './+types/updates.$slug.og-image'

export async function loader({ params }: Route.LoaderArgs) {
  const locale = resolvePublicRouteLocale(params.locale)
  const slug = params.slug
  if (!slug) {
    throw new Response('Not found', { status: 404 })
  }

  const entry = await getVisibleUpdateBySlug(slug, locale)
  if (!entry) {
    throw new Response('Not found', { status: 404 })
  }

  return fetchUpdatesEntryOgImage(entry.title, locale, slug)
}
