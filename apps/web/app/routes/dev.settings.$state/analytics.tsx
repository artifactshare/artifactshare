import type { Route } from './+types/analytics'
import AnalyticsPage from '~/routes/_protected/settings/+components/analytics-page'
import { requireSettingsPage } from './+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'analytics')
}

export default AnalyticsPage
