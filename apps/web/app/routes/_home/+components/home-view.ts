import type { FileRowData } from './file-data'

export interface ProjectBlock {
  id: string | null
  kind: 'inbox' | 'project'
  name: string
  fileCount: number
  fileUpdatedAt: string | null
  recentFiles: FileRowData[]
}

export interface HomeView {
  recent: FileRowData[]
  projectBlocks: ProjectBlock[]
}
