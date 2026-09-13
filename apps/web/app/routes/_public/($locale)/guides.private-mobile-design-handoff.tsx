import { PrivateMobileDesignHandoffPage } from '~/components/app/private-mobile-design-handoff-page'
import { privateMobileDesignHandoffMeta } from '~/lib/private-mobile-design-handoff-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { getPrivateMobileDesignHandoffContent } from '~/services/private-mobile-design-handoff-content.server'
import type { ScreenSpec } from '~/types/screen'
import type { Route } from './+types/guides.private-mobile-design-handoff'

export const screen = {
  id: 'guides-private-mobile-design-handoff',
  route: {
    en: '/guides/private-mobile-design-handoff',
    ja: '/ja/guides/private-mobile-design-handoff',
  },
  auth: 'anonymous',
  loop: 'share',
  metric: '安全なデザイン引き継ぎを増やす',
  role: 'モバイルでの非公開共有を案内する',
  primaryAction: 'ガイドを読む',
  states: [
    {
      id: 'default',
      description: 'モバイル引き継ぎガイド',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export function loader({ params }: Route.LoaderArgs) {
  return getPrivateMobileDesignHandoffContent(
    resolvePublicRouteLocale(params.locale),
  )
}
export function meta({ loaderData }: Route.MetaArgs) {
  return privateMobileDesignHandoffMeta(loaderData?.locale ?? 'en')
}
export default function GuidesPrivateMobileDesignHandoffRoute({
  loaderData,
}: Route.ComponentProps) {
  return <PrivateMobileDesignHandoffPage {...loaderData} />
}
