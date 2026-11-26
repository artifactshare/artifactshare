import type { Route } from './+types/tokens'
import ApiTokensPage from '~/routes/_protected/settings/+components/ai-tools-page'
import { requireSettingsPage } from './+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'tokens')
}

export default ApiTokensPage
