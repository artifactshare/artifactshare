import type { Route } from './+types/_layout'
import SettingsLayout from '~/routes/_protected/settings/+components/settings-layout'
import { AppShell } from '~/routes/_protected/+components/app-shell'
import { requireBillingState } from './+components/billing-states'

// Development only: the real Settings shell and billing page, fed fixture
// data, so states that need Stripe or a nearly full workspace can be opened
// and captured on the local stack. The shared header around them shows the
// fixture workspace and viewer.
export function loader({ params }: Route.LoaderArgs) {
  return requireBillingState(params.state).shell
}

export default function DevSettingsLayout({
  loaderData,
}: Route.ComponentProps) {
  return (
    <AppShell
      data={{
        workspaceName: loaderData.workspace.name,
        user: loaderData.user,
        joinedProjects: [],
      }}
    >
      <SettingsLayout loaderData={loaderData} />
    </AppShell>
  )
}
