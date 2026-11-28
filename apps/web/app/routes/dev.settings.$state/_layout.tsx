import type { Route } from './+types/_layout'
import SettingsLayout from '~/routes/_protected/settings/+components/settings-layout'
import { AppShell } from '~/routes/_protected/+components/app-shell'
import {
  JOINED_PROJECTS,
  requireSettingsState,
} from './+components/settings-states'

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
