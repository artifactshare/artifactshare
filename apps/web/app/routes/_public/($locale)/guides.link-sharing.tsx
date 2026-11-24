import { GuideStaticPage } from '~/components/app/guide-static-page'
import { linkSharingGuideMeta } from '~/lib/link-sharing-guide-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { getLinkSharingGuideContent } from '~/services/link-sharing-guide-content.server'
import type { Route } from './+types/guides.link-sharing'

export function loader({ params }: Route.LoaderArgs) {
  return getLinkSharingGuideContent(resolvePublicRouteLocale(params.locale))
}

export function meta({ loaderData }: Route.MetaArgs) {
  return linkSharingGuideMeta(loaderData?.locale ?? 'en')
}

export default function LinkSharingGuide({ loaderData }: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/link-sharing" />
}
