import type { Route } from './+types/activity'
import ActivityPage from '~/routes/_protected/settings/+components/activity-page'
import { requireSettingsPage } from './+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'activity')
}

export default ActivityPage
