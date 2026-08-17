export interface VersionRow {
  id: string
  ordinal: number
  createdAt: string
  sizeBytes: number
  isCurrent: boolean
  artifactKind?: string | null
  createdByLabel?: string | null
}
