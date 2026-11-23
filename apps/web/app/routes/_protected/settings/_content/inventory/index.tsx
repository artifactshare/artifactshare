import { redirect } from 'react-router'
import type { Route } from './+types/index'
import { requireSettingsAdminPage } from '../../+lib/settings-admin.server'
export function loader({ context }: Route.LoaderArgs) {
  requireSettingsAdminPage(context)
  throw redirect('/settings/inventory/projects')
}
export default function InventoryIndex() {
  return null
}
