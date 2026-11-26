import { useRouteLoaderData } from 'react-router'
import type { Route } from './+types/_layout'
import { requireUserMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  APP_SHELL_ROUTE_ID,
  type AppShellData,
} from '~/routes/_protected/+components/app-shell'
import { appShellShouldRevalidate } from '~/routes/_protected/+lib/app-shell-revalidation'
import { HomeMain } from '../+components/home-main'
import { loadHomeUpload } from '../+lib/home-upload.server'

export const middleware = [requireUserMiddleware]

// Home's lists under the shared header. The header's data comes from the
// shell route; this layout reads only what the upload dialog needs.
export function loader({ context }: Route.LoaderArgs) {
  return loadHomeUpload(createDb(), requireUser(context))
}

export const shouldRevalidate = appShellShouldRevalidate

export default function ProtectedHomeLayout({
  loaderData,
}: Route.ComponentProps) {
  const shell = useRouteLoaderData<AppShellData>(APP_SHELL_ROUTE_ID)
  if (!shell) throw new Error('Home lists render under the app shell')
  return <HomeMain data={{ signedIn: true, ...shell, ...loaderData }} />
}
