import type { Route } from './+types/bots'
import BotsPage from '~/routes/_protected/settings/+components/bots-page'
import { requireSettingsPage } from './+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'bots')
}

export default BotsPage
