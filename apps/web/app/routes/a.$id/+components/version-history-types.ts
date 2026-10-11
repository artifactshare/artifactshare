export interface VersionRow {
  scheduledUpdate?: boolean
  label?: string | null
  id: string
  ordinal: number
  createdAt: string
  sizeBytes: number
  isCurrent: boolean
  isDisplayed?: boolean
  createdByLabel?: string | null
}
