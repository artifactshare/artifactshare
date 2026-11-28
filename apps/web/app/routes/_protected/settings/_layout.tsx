import type { Route } from './+types/_layout'
import { requireUser } from '~/middleware/context'
import { loadSettingsShell } from './+lib/settings-request.server'
import { settingsShellShouldRevalidate } from './+lib/shell-revalidation'
import type { SettingsShellData } from '~/lib/team-management'
import { toUserInfo, type UserInfo } from '~/lib/user'
import SettingsLayout from './+components/settings-layout'

// The view lives in +components so development fixtures can render it without
export default SettingsLayout

export type SettingsLoaderData = SettingsShellData & {
  user: UserInfo
}

export type SettingsLayoutContext = SettingsLoaderData & {
  externalResult?: string | null
}

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
