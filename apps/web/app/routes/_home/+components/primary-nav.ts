import {
  IconFiles,
  IconHistory,
  IconHome,
  IconStack2 as Layers,
} from '@tabler/icons-react'

export const primaryNavItems = [
  ['/', 'tb.home', IconHome],
  ['/recent', 'tb.recent', IconHistory],
  ['/files', 'home.myFiles', IconFiles],
  ['/projects', 'tb.projects', Layers],
] as const

export type JoinedProjectNav = {
  id: string
  name: string
  newCount: number
  workspaceName?: string
}
