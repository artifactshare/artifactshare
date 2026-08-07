import { GuideStaticPage } from '~/components/app/guide-static-page'
import { linkSharingGuideMeta } from '~/lib/link-sharing-guide-meta'
import { getLinkSharingGuideContent } from '~/services/link-sharing-guide-content.server'
import type { Route } from './+types/ja.guides.link-sharing'

export function loader() {
  return getLinkSharingGuideContent('ja')
}

export function meta({ loaderData }: Route.MetaArgs) {
  return linkSharingGuideMeta(loaderData?.locale ?? 'ja')
}

export default function JaLinkSharingGuide({
  loaderData,
}: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/link-sharing" />
}
