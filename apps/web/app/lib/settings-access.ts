/** Settings pages that only workspace admins may open. */
export type SettingsAdminPage = 'bots' | 'activity' | 'inventory'

/**
 * Whether a viewer may open an admin-only Settings page. The Settings menu and
 * the admin gate both decide with this, so the menu lists exactly the pages
 * the gate lets through.
 *
 * - `forbidden`: not an admin of the workspace.
 * - `not-team`: an admin of a workspace whose plan lacks the page (inventory
 *   is Team-only); the gate sends them back to Settings.
 */
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

/**
 * The admin-only page a matched route pattern belongs to, if any. The pattern
 * comes from the router's match, so every spelling of the URL the router
 * accepts (letter case, percent-encoding) selects the same page.
 */
export function settingsAdminPageFor(
  pattern: string,
): SettingsAdminPage | null {
  return ADMIN_PAGES[pattern.replace(/^\/+|\/+$/g, '')] ?? null
}
