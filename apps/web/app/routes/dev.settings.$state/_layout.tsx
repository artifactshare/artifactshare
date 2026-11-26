import type { Route } from './+types/_layout'
import SettingsLayout from '~/routes/_protected/settings/+components/settings-layout'
import { AppShell } from '~/routes/_protected/+components/app-shell'
import { JOINED_PROJECTS, requireSettingsState } from './+components/settings-states'

// Development only: the real Settings shell and pages, fed fixture data, so
// workspace situations that need Stripe, a nearly full workspace or a team's
// history can be opened and captured on the local stack. The shared header
// around them shows the fixture workspace and viewer.
export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsState(params.state).shell
}

export default function DevSettingsLayout({
  loaderData,
}: Route.ComponentProps) {
  return (
    <AppShell
      data={{
        workspaceName: loaderData.workspace.name,
        user: loaderData.user,
        joinedProjects: JOINED_PROJECTS,
      }}
    >
      <SettingsLayout loaderData={loaderData} />
    </AppShell>
  )
}
