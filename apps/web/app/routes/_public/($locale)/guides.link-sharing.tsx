import { GuideStaticPage } from '~/components/app/guide-static-page'
import { linkSharingGuideMeta } from '~/lib/link-sharing-guide-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { getLinkSharingGuideContent } from '~/services/link-sharing-guide-content.server'
import type { ScreenSpec } from '~/types/screen'
import type { Route } from './+types/guides.link-sharing'

export const screen = {
  id: 'guides-link-sharing',
  route: {
    en: '/guides/link-sharing',
    ja: '/ja/guides/link-sharing',
  },
  auth: 'anonymous',
  loop: 'share',
  metric: 'リンク共有の利用を増やす',
  role: 'リンク共有の手順を案内する',
  primaryAction: 'ガイドを読む',
  states: [
    {
      id: 'default',
      description: 'リンク共有ガイド',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export function loader({ params }: Route.LoaderArgs) {
  return getLinkSharingGuideContent(resolvePublicRouteLocale(params.locale))
}

export function meta({ loaderData }: Route.MetaArgs) {
  return linkSharingGuideMeta(loaderData?.locale ?? 'en')
}

export default function LinkSharingGuide({ loaderData }: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/link-sharing" />
}
