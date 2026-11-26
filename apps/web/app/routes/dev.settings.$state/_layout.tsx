import type { Route } from './+types/_layout'
import SettingsLayout from '~/routes/_protected/settings/+components/settings-layout'
import { requireBillingState } from './+components/billing-states'

// Development only: the real Settings shell and billing page, fed fixture
// data, so states that need Stripe or a nearly full workspace can be opened
// and captured on the local stack.
export function loader({ params }: Route.LoaderArgs) {
  return requireBillingState(params.state).shell
}

export default SettingsLayout
