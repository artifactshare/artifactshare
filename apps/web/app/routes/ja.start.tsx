import { GettingStartedPage } from '~/components/app/getting-started-page'
import { gettingStartedMeta } from '~/lib/getting-started-meta'
import type { Route } from './+types/ja.start'
import { userContext } from '~/middleware/context'

export function loader({ context }: Route.LoaderArgs) {
  return {
    locale: 'ja' as const,
    signedIn: Boolean(context.get(userContext)),
  }
}

export function meta({ loaderData }: Route.MetaArgs) {
  return gettingStartedMeta(loaderData?.locale ?? 'ja')
}

export default function JaStartRoute({ loaderData }: Route.ComponentProps) {
  return (
    <GettingStartedPage
      locale={loaderData.locale}
      signedIn={loaderData.signedIn}
    />
  )
}
