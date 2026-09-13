import { UpdatesDetailPage } from '~/components/app/updates-page'
import { data } from 'react-router'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { updatesDetailMeta } from '~/lib/updates-meta'
import {
  getVisibleUpdateBySlug,
  toDetail,
} from '~/services/updates-visibility.server'
import type { Route } from './+types/updates.$slug'
import { mergeUpdatesNotice } from '~/lib/updates-notice.server'
import { getLatestVisibleNotice } from '~/services/updates-visibility.server'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'updates-detail',
  route: {
    en: '/updates/{seed:update}',
    ja: '/ja/updates/{seed:update}',
  },
  auth: 'anonymous',
  loop: 'support',
  metric: '更新内容の理解を深める',
  role: '製品更新の詳細を伝える',
  primaryAction: '次の更新を見る',
  states: [
    {
      id: 'default',
      description: '更新詳細',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export async function loader({ params, request }: Route.LoaderArgs) {
  const slug = params.slug
  if (!slug) {
    throw new Response(null, { status: 404 })
  }

  const [entry, notice] = await Promise.all([
    getVisibleUpdateBySlug(slug, DEFAULT_LOCALE),
    getLatestVisibleNotice(),
  ])
  if (!entry) {
    throw new Response(null, { status: 404 })
  }

  return data(
    { entry: toDetail(entry) },
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
  if (!loaderData?.entry) {
    return []
  }
  return updatesDetailMeta(loaderData.entry, DEFAULT_LOCALE)
}

export default function UpdatesSlugRoute({ loaderData }: Route.ComponentProps) {
  return <UpdatesDetailPage locale={DEFAULT_LOCALE} entry={loaderData.entry} />
}
