import type { Route } from './+types/artifacts'
import ArtifactsPage from '~/routes/_protected/settings/_content/inventory/+components/artifacts-page'
import { requireSettingsPage } from '../+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'inventoryArtifacts')
}

export default ArtifactsPage
