import type { ReactNode } from 'react'
import { useMatches } from 'react-router'
import type { UserInfo } from '~/lib/user'
import { Topbar } from '~/routes/_home/+components/topbar'
import { BottomTabBar } from '~/routes/_home/+components/bottom-tab-bar'
import type { JoinedProjectNav } from '~/routes/_home/+components/primary-nav'

/** The shell route, whose data the pages under it can read. */
export const APP_SHELL_ROUTE_ID = 'routes/_protected/_shell'

export type AppShellData = {
  workspaceName: string
  user: UserInfo
  joinedProjects: JoinedProjectNav[]
}

/**
 * What a page under the shell tells the header. A project page names its
 * project, so the search in the header can be narrowed to it.
 */
export type AppShellHandle = {
  searchProject?: (loaderData: unknown) => { id: string; name: string } | null
}

function useSearchProject() {
  const matches = useMatches()
  for (const match of [...matches].reverse()) {
    const handle = match.handle as AppShellHandle | undefined
    if (handle?.searchProject && match.loaderData) {
      return handle.searchProject(match.loaderData) ?? undefined
    }
  }
  return undefined
}

/**
 * The header and the bottom tab bar every signed-in page shares. The page
 * renders its own `<main>` between them.
 */
export function AppShell({
  data,
  children,
}: {
  data: AppShellData
  children: ReactNode
}) {
  const searchProject = useSearchProject()
  return (
    <>
      <Topbar
        workspaceName={data.workspaceName || '—'}
        user={data.user}
        joinedProjects={data.joinedProjects}
        searchProject={searchProject}
      />
      {children}
      <BottomTabBar />
    </>
  )
}
