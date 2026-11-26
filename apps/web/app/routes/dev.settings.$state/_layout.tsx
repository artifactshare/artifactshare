import type { Route } from './+types/_layout'
import SettingsLayout from '~/routes/_protected/settings/+components/settings-layout'
import { requireSettingsState } from './+components/settings-states'

// Development only: the real Settings shell and pages, fed fixture data, so
// workspace situations that need Stripe, a nearly full workspace or a team's
// history can be opened and captured on the local stack.
export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsState(params.state).shell
}

export default SettingsLayout
