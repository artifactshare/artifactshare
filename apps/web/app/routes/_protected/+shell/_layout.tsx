import { Outlet } from 'react-router'
import type { Route } from './+types/_layout'
import { AppShell } from '../+components/app-shell'
import { loadAppShell } from '../+lib/app-shell.server'
import { appShellShouldRevalidate } from '../+lib/app-shell-revalidation'

// The header and the bottom tab bar of the signed-in pages: Home's lists,
// Settings and the project pages. They read the joined projects only here.
// The signed-in Home at `/` sits in the public locale tree and renders the
// same shell from its own layout.
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
