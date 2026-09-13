import { UpdatesListPage } from '~/components/app/updates-page'
import { data } from 'react-router'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { parseProductFilter, updatesListMeta } from '~/lib/updates-meta'
import {
  getVisibleUpdates,
  toListItem,
} from '~/services/updates-visibility.server'
import type { Route } from './+types/updates'
import { mergeUpdatesNotice } from '~/lib/updates-notice.server'
import { getLatestVisibleNotice } from '~/services/updates-visibility.server'
import type { ScreenSpec } from '~/types/screen'

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

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const product = parseProductFilter(url.searchParams.get('product'))
  const [entries, notice] = await Promise.all([
    getVisibleUpdates(DEFAULT_LOCALE, product),
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

export function meta() {
  return updatesListMeta(DEFAULT_LOCALE)
}

export default function UpdatesRoute({ loaderData }: Route.ComponentProps) {
  return (
    <UpdatesListPage
      locale={DEFAULT_LOCALE}
      entries={loaderData.entries}
      product={loaderData.product}
    />
  )
}
