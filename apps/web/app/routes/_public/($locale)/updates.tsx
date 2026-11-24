import { data } from 'react-router'

import { UpdatesListPage } from '~/components/app/updates-page'
import { parseProductFilter, updatesListMeta } from '~/lib/updates-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { mergeUpdatesNotice } from '~/lib/updates-notice.server'
import {
  getLatestVisibleNotice,
  getVisibleUpdates,
  toListItem,
} from '~/services/updates-visibility.server'
import type { Route } from './+types/updates'

export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = resolvePublicRouteLocale(params.locale)
  const url = new URL(request.url)
  const product = parseProductFilter(url.searchParams.get('product'))
  const [entries, notice] = await Promise.all([
    getVisibleUpdates(locale, product),
    getLatestVisibleNotice(),
  ])
  return data(
    { entries: entries.map(toListItem), product },
    notice
      ? {
          headers: {
            'Set-Cookie': mergeUpdatesNotice(request, notice.slug, true),
          },
        }
      : undefined,
  )
}

export function meta({ params }: Route.MetaArgs) {
  return updatesListMeta(resolvePublicRouteLocale(params.locale))
}

export default function UpdatesRoute({
  loaderData,
  params,
}: Route.ComponentProps) {
  return (
    <UpdatesListPage
      locale={resolvePublicRouteLocale(params.locale)}
      entries={loaderData.entries}
      product={loaderData.product}
    />
  )
}
