import { createContext, type RouterContextProvider } from 'react-router'
import { logErrorDiagnostic } from '~/lib/error-diagnostics.server'
import { toUserInfo } from '~/lib/user'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { listJoinedProjectsForDropdown } from '~/services/project-membership.server'
import type { JoinedProjectNav } from '~/routes/_home/+components/primary-nav'
import type { AppShellData } from '../+components/app-shell'
import { settingsWorkspace } from '../settings/+lib/settings-request.server'

const JOINED_PROJECTS_IN_NAV = 5

export type JoinedProjectRow = Awaited<
  ReturnType<typeof listJoinedProjectsForDropdown>
>[number]

const joinedProjectsRead = createContext<Promise<JoinedProjectRow[]> | null>(
  null,
)

export function requestJoinedProjects(
  context: Readonly<RouterContextProvider>,
): Promise<JoinedProjectRow[]> {
  let read = context.get(joinedProjectsRead)
  if (!read) {
    read = listJoinedProjectsForDropdown(
      createDb(),
      requireUser(context),
      JOINED_PROJECTS_IN_NAV,
    )
    context.set(joinedProjectsRead, read)
  }
  return read
}

export function toJoinedProjectNav(
  rows: JoinedProjectRow[],
): JoinedProjectNav[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    newCount: row.newCount,
    workspaceName: row.workspaceName,
  }))
}

function shellWorkspaceName(context: Readonly<RouterContextProvider>) {
  return settingsWorkspace(context).then(
    (workspace) => workspace.name,
    () => 'Files',
  )
}

export async function loadAppShell(
  context: Readonly<RouterContextProvider>,
): Promise<AppShellData> {
  const user = requireUser(context)
  const [workspaceName, joined] = await Promise.all([
    shellWorkspaceName(context),
    requestJoinedProjects(context).catch((error) => {
      logErrorDiagnostic('app-shell.joined-projects', error)
      return []
    }),
  ])
  return {
    workspaceName,
    user: toUserInfo(user),
    joinedProjects: toJoinedProjectNav(joined),
  }
}
