import { data } from 'react-router'

import { UpdatesDetailPage } from '~/components/app/updates-page'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { mergeUpdatesNotice } from '~/lib/updates-notice.server'
import { updatesDetailMeta } from '~/lib/updates-meta'
import {
  getLatestVisibleNotice,
  getVisibleUpdateBySlug,
  toDetail,
} from '~/services/updates-visibility.server'
import type { ScreenSpec } from '~/types/screen'
import type { Route } from './+types/updates.$slug'

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
  const locale = resolvePublicRouteLocale(params.locale)
  const slug = params.slug
  if (!slug) {
    throw new Response(null, { status: 404 })
  }

  const [entry, notice] = await Promise.all([
    getVisibleUpdateBySlug(slug, locale),
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

export function meta({ loaderData, params }: Route.MetaArgs) {
  if (!loaderData?.entry) {
    return []
  }
  return updatesDetailMeta(
    loaderData.entry,
    resolvePublicRouteLocale(params.locale),
  )
}

export default function UpdatesSlugRoute({
  loaderData,
  params,
}: Route.ComponentProps) {
  return (
    <UpdatesDetailPage
      locale={resolvePublicRouteLocale(params.locale)}
      entry={loaderData.entry}
    />
  )
}
