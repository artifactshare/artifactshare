import { logErrorDiagnostic } from '~/lib/error-diagnostics.server'
import type { Route } from './+types/_layout'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { loadSettingsShell } from './+lib/settings-request.server'
import { settingsShellShouldRevalidate } from './+lib/shell-revalidation'
import { listJoinedProjectsForDropdown } from '~/services/project-membership.server'
import type { JoinedProjectNav } from '../../_home/+components/primary-nav'
import type { SettingsShellData } from '~/lib/team-management'
import { toUserInfo, type UserInfo } from '~/lib/user'
import SettingsLayout from './+components/settings-layout'

// The view lives in +components so development fixtures can render it without
// this module's server code. React Router passes loaderData only to a default
// export declared in the route module, so `export { default } from` would not.
export default SettingsLayout

export type SettingsLoaderData = SettingsShellData & {
  user: UserInfo
  joinedProjects: JoinedProjectNav[]
}

export type SettingsLayoutContext = SettingsLoaderData & {
  externalResult?: string | null
}

// Settings is the only reader of the shell: pages receive it through the
// outlet context and load only their own data.
export async function loader({
  context,
}: Route.LoaderArgs): Promise<SettingsLoaderData> {
  const user = requireUser(context)
  const db = createDb()
  const [settingsShell, joinedProjects] = await Promise.all([
    loadSettingsShell(context),
    listJoinedProjectsForDropdown(db, user, 5)
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          newCount: row.newCount,
          workspaceName: row.workspaceName,
        })),
      )
      .catch((error) => {
        logErrorDiagnostic('settings.projects', error)
        return []
      }),
  ])
  return {
    ...settingsShell,
    user: toUserInfo(user),
    joinedProjects,
  }
}

export const shouldRevalidate = settingsShellShouldRevalidate
