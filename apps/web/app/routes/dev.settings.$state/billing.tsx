import type { Route } from './+types/billing'
import BillingPage from '~/routes/_protected/settings/+components/billing-page'
import { requireSettingsPage } from './+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'billing')
}

export default BillingPage
