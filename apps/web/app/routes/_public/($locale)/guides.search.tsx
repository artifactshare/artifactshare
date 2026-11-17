import { GuideStaticPage } from '~/components/app/guide-static-page'
import { searchGuideMeta } from '~/lib/search-guide-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { getSearchGuideContent } from '~/services/search-guide-content.server'
import type { ScreenSpec } from '~/types/screen'
import type { Route } from './+types/guides.search'

export const screen = {
  id: 'guides-search',
  route: {
    en: '/guides/search',
    ja: '/ja/guides/search',
  },
  auth: 'anonymous',
  loop: 'share',
  metric: 'ファイルを検索で見つける',
  role: '検索の手順を案内する',
  primaryAction: 'ガイドを読む',
  states: [
    {
      id: 'default',
      description: '検索ガイド',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export function loader({ params }: Route.LoaderArgs) {
  return getSearchGuideContent(resolvePublicRouteLocale(params.locale))
}

export function meta({ loaderData }: Route.MetaArgs) {
  return searchGuideMeta(loaderData?.locale ?? 'en')
}

export default function SearchGuide({ loaderData }: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/search" />
}
