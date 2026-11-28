export const ARTIFACT_KINDS = [
  'markdown_page',
  'html_page',
  'static_site',
  'spa',
  'workspace_app',
  'pdf',
  'video',
] as const

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number]

export type Visibility = 'private' | 'workspace' | 'project' | 'link'

export type EditableVisibility = Visibility

export type ContainerKind = 'project' | 'inbox'

export type ProjectBaseVisibility = 'workspace' | 'private'

export type ProjectShareRole = 'viewer' | 'contributor' | 'manager'

export const PROJECT_SHARE_ROLES = [
  'viewer',
  'contributor',
  'manager',
] as const satisfies ReadonlyArray<ProjectShareRole>

export const EDITABLE_VISIBILITIES: ReadonlySet<EditableVisibility> = new Set([
  'private',
  'workspace',
  'project',
  'link',
])

export function availableVisibilitiesFor(
  isOrg: boolean,
  containerKind: ContainerKind = 'inbox',
): ReadonlyArray<EditableVisibility> {
  const visibilities: EditableVisibility[] = ['private']
  if (containerKind === 'project') visibilities.push('project')
  if (isOrg) visibilities.push('workspace')
  visibilities.push('link')
  return visibilities
}

export function defaultVisibilityFor(
  isOrg: boolean,
  containerKind: ContainerKind = 'inbox',
): EditableVisibility {
  if (containerKind === 'project') return 'project'
  return isOrg ? 'workspace' : 'private'
}

/**
 * The visibility a newly published artifact gets. Naming people to share with
 * is itself a visibility choice: a grant list makes the artifact private to
 * that list, instead of taking the account's or the project's default.
 */
export function visibilityForNewArtifact(input: {
  requested: EditableVisibility | null | undefined
  grantedEmailCount: number
  isOrg: boolean
  containerKind: ContainerKind
}): EditableVisibility {
  return (
    input.requested ??
    (input.grantedEmailCount > 0
      ? 'private'
      : defaultVisibilityFor(input.isOrg, input.containerKind))
  )
}

/**
 * `shareables.artifact_kind` and `versions.artifact_kind` are plain TEXT with
 * no CHECK constraint, so a row read back is a string until this says
 * otherwise.
 */
export function isArtifactKind(value: unknown): value is ArtifactKind {
  return (ARTIFACT_KINDS as ReadonlyArray<unknown>).includes(value)
}

export function isVisibility(value: unknown): value is Visibility {
  return (
    value === 'private' ||
    value === 'workspace' ||
    value === 'project' ||
    value === 'link'
  )
}

export function visibilityForContainer(
  visibility: Visibility,
  containerKind: ContainerKind | null,
): Visibility {
  return visibility === 'project' && containerKind !== 'project'
    ? 'private'
    : visibility
}

export function bodyPreviewEligible(
  visibility: Visibility,
  containerBaseVisibility: 'workspace' | 'private' | null,
): boolean {
  return (
    visibility === 'link' ||
    visibility === 'workspace' ||
    (visibility === 'project' && containerBaseVisibility === 'workspace')
  )
}

export type VersionStatus =
  | 'uploading'
  | 'scanning'
  | 'published'
  | 'blocked'
  | 'failed'
