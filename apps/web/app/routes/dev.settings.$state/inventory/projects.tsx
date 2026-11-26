import type { Route } from './+types/projects'
import ProjectsPage from '~/routes/_protected/settings/_content/inventory/+components/projects-page'
import { requireSettingsPage } from '../+components/settings-states'

export function loader({ params }: Route.LoaderArgs) {
  return requireSettingsPage(params.state, 'inventoryProjects')
}

export default ProjectsPage
