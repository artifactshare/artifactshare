import { UpdatesListPage } from '~/components/app/updates-page'
import { data } from 'react-router'
import { parseProductFilter, updatesListMeta } from '~/lib/updates-meta'
import type { Route } from './+types/ja.updates'
import {
  getVisibleUpdates,
  toListItem,
} from '~/services/updates-visibility.server'
import { mergeUpdatesNotice } from '~/lib/updates-notice.server'
import { getLatestVisibleNotice } from '~/services/updates-visibility.server'

export function meta() {
  return updatesListMeta('ja')
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url)
  const product = parseProductFilter(url.searchParams.get('product'))
  const [entries, notice] = await Promise.all([
    getVisibleUpdates('ja', product),
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

export default function JaUpdatesRoute({ loaderData }: Route.ComponentProps) {
  return (
    <UpdatesListPage
      locale="ja"
      entries={loaderData.entries}
      product={loaderData.product}
    />
  )
}
