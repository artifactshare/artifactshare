export type SettingsAdminPage = 'bots' | 'activity' | 'inventory'

export function settingsAdminPageAccess(
  page: SettingsAdminPage,
  viewer: { isAdmin: boolean; team: boolean },
): 'allowed' | 'forbidden' | 'not-team' {
  if (!viewer.isAdmin) return 'forbidden'
  if (page === 'inventory' && !viewer.team) return 'not-team'
  return 'allowed'
}

const ADMIN_PAGES: Record<string, SettingsAdminPage> = {
  'settings/bots': 'bots',
  'settings/activity': 'activity',
  'settings/inventory': 'inventory',
  'settings/inventory/projects': 'inventory',
  'settings/inventory/artifacts': 'inventory',
}

export function settingsAdminPageFor(
  pattern: string,
): SettingsAdminPage | null {
  return ADMIN_PAGES[pattern.replace(/^\/+|\/+$/g, '')] ?? null
}
