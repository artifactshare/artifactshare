import { redirect } from 'react-router'
import type { Route } from './+types/index'
import { requireSettingsPage } from '../+components/settings-states'

// The menu's inventory item opens the projects tab, as in Settings.
export function loader({ params }: Route.LoaderArgs) {
  requireSettingsPage(params.state, 'inventoryProjects')
  throw redirect(`/dev/settings/${params.state}/inventory/projects`)
}

export default function InventoryIndex() {
  return null
}
