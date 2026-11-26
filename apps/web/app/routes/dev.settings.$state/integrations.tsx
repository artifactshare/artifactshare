import type { Route } from './+types/integrations'
import IntegrationsPage from '~/routes/_protected/settings/+components/integrations-page'
import { requireSettingsPage } from './+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'integrations')
}

export default IntegrationsPage
