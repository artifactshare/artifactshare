import { GettingStartedPage } from '~/components/app/getting-started-page'
import { gettingStartedMeta } from '~/lib/getting-started-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { userContext } from '~/middleware/context'
import type { Route } from './+types/start'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'start',
  route: {
    en: '/start',
    ja: '/ja/start',
  },
  auth: 'anonymous',
  loop: 'create',
  metric: '初回作成への到達率を高める',
  role: '利用開始の手順を案内する',
  primaryAction: 'アカウントを作る',
  states: [
    {
      id: 'default',
      description: '通常の Start',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export function meta({ loaderData }: Route.MetaArgs) {
  return gettingStartedMeta(loaderData?.locale ?? 'en')
}

export function loader({ params, context }: Route.LoaderArgs) {
  return {
    locale: resolvePublicRouteLocale(params.locale),
    signedIn: Boolean(context.get(userContext)),
  }
}

export default function StartRoute({ loaderData }: Route.ComponentProps) {
  return (
    <GettingStartedPage
      locale={loaderData.locale}
      signedIn={loaderData.signedIn}
    />
  )
}
