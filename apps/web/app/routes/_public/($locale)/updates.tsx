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
import type { ScreenSpec } from '~/types/screen'
import type { Route } from './+types/updates'

export const screen = {
  id: 'updates',
  route: {
    en: '/updates',
    ja: '/ja/updates',
  },
  auth: 'anonymous',
  loop: 'support',
  metric: '継続的な関心と再訪を増やす',
  role: '製品更新を一覧で知らせる',
  primaryAction: '更新を読む',
  states: [
    {
      id: 'default',
      description: '更新一覧',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export async function loader({ params, request }: Route.LoaderArgs) {
  const locale = resolvePublicRouteLocale(params.locale)
  const url = new URL(request.url)
  const product = parseProductFilter(url.searchParams.get('product'))
  const [entries, notice] = await Promise.all([
    getVisibleUpdates(locale, product),
    getLatestVisibleNotice(),
  ])
  return data(
    { locale, entries: entries.map(toListItem), product },
    notice
      ? {
          headers: {
            'Set-Cookie': mergeUpdatesNotice(request, notice.slug, true),
          },
        }
      : undefined,
  )
}

export function meta({ loaderData }: Route.MetaArgs) {
  return updatesListMeta(loaderData?.locale ?? 'en')
}

export default function UpdatesRoute({ loaderData }: Route.ComponentProps) {
  return (
    <UpdatesListPage
      locale={loaderData.locale}
      entries={loaderData.entries}
      product={loaderData.product}
    />
  )
}
