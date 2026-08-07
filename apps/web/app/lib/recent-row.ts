import type { FileRowData } from '~/routes/_home/+components/file-data'

export type RestrictedRecentRow = {
  kind: 'restricted'
  shareableId: string
  title: string
  ownerName: string | null
  ownerImage: string | null
  lastViewedAt: string | null
}

export type RecentRow =
  | { kind: 'file'; file: FileRowData }
  | RestrictedRecentRow
