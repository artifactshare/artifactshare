import { GettingStartedPage } from '~/components/app/getting-started-page'
import { gettingStartedMeta } from '~/lib/getting-started-meta'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { userContext } from '~/middleware/context'
import type { Route } from './+types/start'
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
