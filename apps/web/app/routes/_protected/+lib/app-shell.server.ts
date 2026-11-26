import { createContext, type RouterContextProvider } from 'react-router'
import { logErrorDiagnostic } from '~/lib/error-diagnostics.server'
import { toUserInfo } from '~/lib/user'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { listJoinedProjectsForDropdown } from '~/services/project-membership.server'
import type { JoinedProjectNav } from '~/routes/_home/+components/primary-nav'
import type { AppShellData } from '../+components/app-shell'
import { settingsWorkspace } from '../settings/+lib/settings-request.server'

/** How many joined projects the header's projects menu lists. */
const JOINED_PROJECTS_IN_NAV = 5

export type JoinedProjectRow = Awaited<
  ReturnType<typeof listJoinedProjectsForDropdown>
>[number]

// Kept in the request's own router context, so a read never outlives its
// request.
const joinedProjectsRead = createContext<Promise<JoinedProjectRow[]> | null>(
  null,
)

/**
 * The viewer's joined projects, newest activity first, as many as the header
 * lists. Read at most once per request, so the shell and a page that shows
 * fewer of them (Home's rail) share one read.
 */
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

/**
 * The workspace name the header shows. It comes from the per-request
 * workspace read Settings also uses, so a Settings page reads the row once.
 */
function shellWorkspaceName(context: Readonly<RouterContextProvider>) {
  return settingsWorkspace(context).then(
    (workspace) => workspace.name,
    () => 'Files',
  )
}

/** What the header and the bottom tab bar of every signed-in page show. */
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
