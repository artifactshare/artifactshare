import { Outlet } from 'react-router'
import type { Route } from './+types/_layout'
import { AppShell } from '../+components/app-shell'
import { loadAppShell } from '../+lib/app-shell.server'
import { appShellShouldRevalidate } from '../+lib/app-shell-revalidation'

export function loader({ context }: Route.LoaderArgs) {
  return loadAppShell(context)
}

export const shouldRevalidate = appShellShouldRevalidate

export default function AppShellLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AppShell data={loaderData}>
      <Outlet />
    </AppShell>
  )
}
