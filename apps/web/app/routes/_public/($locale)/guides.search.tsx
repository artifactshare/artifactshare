import { GuideStaticPage } from '~/components/app/guide-static-page'
import { searchGuideMeta } from '~/lib/search-guide-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { getSearchGuideContent } from '~/services/search-guide-content.server'
import type { Route } from './+types/guides.search'

export function loader({ params }: Route.LoaderArgs) {
  return getSearchGuideContent(resolvePublicRouteLocale(params.locale))
}

export function meta({ loaderData }: Route.MetaArgs) {
  return searchGuideMeta(loaderData?.locale ?? 'en')
}

export default function SearchGuide({ loaderData }: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/search" />
}
