import { Outlet } from 'react-router'
import type { Route } from './+types/_layout'
import { Landing } from '~/routes/_home/+components/landing'
import {
  HomeMain,
  type HomeLayoutData,
} from '~/routes/_home/+components/home-main'
import { loadHomeUpload } from '~/routes/_home/+lib/home-upload.server'
import { linkDomainContext, userContext } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { AppShell } from '~/routes/_protected/+components/app-shell'
import { loadAppShell } from '~/routes/_protected/+lib/app-shell.server'
import { appShellShouldRevalidate } from '~/routes/_protected/+lib/app-shell-revalidation'

export async function loader({
  context,
}: Route.LoaderArgs): Promise<HomeLayoutData> {
  if (context.get(linkDomainContext)) {
    return { signedIn: false, linkDomain: true }
  }
  const user = context.get(userContext)
  if (!user) return { signedIn: false }

  const [shell, upload] = await Promise.all([
    loadAppShell(context),
    loadHomeUpload(createDb(), user),
  ])
  return { signedIn: true, ...shell, ...upload }
}

export const shouldRevalidate = appShellShouldRevalidate

export default function HomeLayout({ loaderData }: Route.ComponentProps) {
  if (!loaderData.signedIn) {
    return loaderData.linkDomain ? <Outlet /> : <Landing />
  }
  return (
    <AppShell data={loaderData}>
      <HomeMain data={loaderData} />
    </AppShell>
  )
}
