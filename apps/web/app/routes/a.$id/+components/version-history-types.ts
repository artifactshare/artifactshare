export interface VersionRow {
  id: string
  ordinal: number
  createdAt: string
  sizeBytes: number
  isCurrent: boolean
  isDisplayed?: boolean
  createdByLabel?: string | null
}
