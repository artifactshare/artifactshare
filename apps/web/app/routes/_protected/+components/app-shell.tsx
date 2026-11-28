import type { ReactNode } from 'react'
import { useMatches } from 'react-router'
import type { UserInfo } from '~/lib/user'
import { Topbar } from '~/routes/_home/+components/topbar'
import { BottomTabBar } from '~/routes/_home/+components/bottom-tab-bar'
import type { JoinedProjectNav } from '~/routes/_home/+components/primary-nav'

export const APP_SHELL_ROUTE_ID = 'routes/_protected/_shell'

export type AppShellData = {
  workspaceName: string
  user: UserInfo
  joinedProjects: JoinedProjectNav[]
}

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
