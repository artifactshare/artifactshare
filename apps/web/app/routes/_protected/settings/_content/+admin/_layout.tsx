import { Outlet, useOutletContext } from 'react-router'
import type { SettingsLayoutContext } from '../../_layout'
import { settingsAdminMiddleware } from '../../+lib/settings-admin.server'

// Bots, activity and inventory: one admin decision for all of them. A refusal
// is the 403 the Settings content boundary shows at the requested URL.
export const middleware = [settingsAdminMiddleware]

export default function SettingsAdminLayout() {
  return <Outlet context={useOutletContext<SettingsLayoutContext>()} />
}
