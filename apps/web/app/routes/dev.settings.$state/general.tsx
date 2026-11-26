import type { Route } from './+types/general'
import GeneralPage from '~/routes/_protected/settings/+components/general-page'
import { requireSettingsPage } from './+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'general')
}

export default GeneralPage
