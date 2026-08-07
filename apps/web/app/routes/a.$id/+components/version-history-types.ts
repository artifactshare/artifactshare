export interface VersionRow {
  id: string
  ordinal: number
  createdAt: string
  sizeBytes: number
  isCurrent: boolean
  createdByLabel?: string | null
}
