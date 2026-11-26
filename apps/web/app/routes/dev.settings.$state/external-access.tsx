import type { Route } from './+types/external-access'
import ExternalAccessPage from '~/routes/_protected/settings/+components/external-access-page'
import { requireSettingsPage } from './+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'externalAccess')
}

export default ExternalAccessPage
