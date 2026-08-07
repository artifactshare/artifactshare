import { data } from 'react-router'
import type { Route } from './+types/notice-updates'
import { mergeUpdatesNotice } from '~/lib/updates-notice.server'
import { getLatestVisibleNotice } from '~/services/updates-visibility.server'
export async function action({ request }: Route.ActionArgs) {
  const notice = await getLatestVisibleNotice()
  return data(null, {
    headers: notice
      ? { 'Set-Cookie': mergeUpdatesNotice(request, notice.slug) }
      : undefined,
  })
}
