import { Outlet, useOutletContext } from 'react-router'
import type { SettingsLayoutContext } from '../../_layout'
import { settingsAdminMiddleware } from '../../+lib/settings-admin.server'

export const middleware = [settingsAdminMiddleware]

export default function SettingsAdminLayout() {
  return <Outlet context={useOutletContext<SettingsLayoutContext>()} />
}
