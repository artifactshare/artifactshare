import { GuideStaticPage } from '~/components/app/guide-static-page'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { linkSharingGuideMeta } from '~/lib/link-sharing-guide-meta'
import { getLinkSharingGuideContent } from '~/services/link-sharing-guide-content.server'
import type { Route } from './+types/guides.link-sharing'
import type { ScreenSpec } from '~/types/screen'

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

export function loader() {
  return getLinkSharingGuideContent(DEFAULT_LOCALE)
}

export function meta({ loaderData }: Route.MetaArgs) {
  return linkSharingGuideMeta(loaderData?.locale ?? DEFAULT_LOCALE)
}

export default function LinkSharingGuide({ loaderData }: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/link-sharing" />
}
