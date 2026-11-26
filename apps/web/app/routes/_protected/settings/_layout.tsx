import type { Route } from './+types/_layout'
import { requireUser } from '~/middleware/context'
import { loadSettingsShell } from './+lib/settings-request.server'
import { settingsShellShouldRevalidate } from './+lib/shell-revalidation'
import type { SettingsShellData } from '~/lib/team-management'
import { toUserInfo, type UserInfo } from '~/lib/user'
import SettingsLayout from './+components/settings-layout'

// The view lives in +components so development fixtures can render it without
// this module's server code. React Router passes loaderData only to a default
// export declared in the route module, so `export { default } from` would not.
export default SettingsLayout

export type SettingsLoaderData = SettingsShellData & {
  user: UserInfo
}

export type SettingsLayoutContext = SettingsLoaderData & {
  externalResult?: string | null
}

// Settings is the only reader of the shell: pages receive it through the
// outlet context and load only their own data. The header above it belongs to
// the app shell.
export async function loader({
  context,
}: Route.LoaderArgs): Promise<SettingsLoaderData> {
  const user = requireUser(context)
  return {
    ...(await loadSettingsShell(context)),
    user: toUserInfo(user),
  }
}

export const shouldRevalidate = settingsShellShouldRevalidate
