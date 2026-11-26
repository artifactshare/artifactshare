import type { Route } from './+types/billing'
import BillingPage from '~/routes/_protected/settings/+components/billing-page'
import { requireBillingState } from './+components/billing-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireBillingState(params.state).billing
}

export default BillingPage
