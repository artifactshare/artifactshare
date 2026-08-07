import { GettingStartedPage } from '~/components/app/getting-started-page'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { gettingStartedMeta } from '~/lib/getting-started-meta'
import { userContext } from '~/middleware/context'
import type { Route } from './+types/start'

export function meta({ loaderData }: Route.MetaArgs) {
  return gettingStartedMeta(loaderData?.locale ?? DEFAULT_LOCALE)
}

export function loader({ context }: Route.LoaderArgs) {
  return {
    locale: DEFAULT_LOCALE,
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
