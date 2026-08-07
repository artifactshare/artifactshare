import { GuideStaticPage } from '~/components/app/guide-static-page'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { linkSharingGuideMeta } from '~/lib/link-sharing-guide-meta'
import { getLinkSharingGuideContent } from '~/services/link-sharing-guide-content.server'
import type { Route } from './+types/guides.link-sharing'

export function loader() {
  return getLinkSharingGuideContent(DEFAULT_LOCALE)
}

export function meta({ loaderData }: Route.MetaArgs) {
  return linkSharingGuideMeta(loaderData?.locale ?? DEFAULT_LOCALE)
}

export default function LinkSharingGuide({ loaderData }: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/link-sharing" />
}
