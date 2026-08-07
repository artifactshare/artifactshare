// String union types for the shareables / versions schema. Co-locating
// them keeps app/types/db.ts in sync with the SQL constraints and lets
// non-DB code import the enums without pulling the whole DB type tree.

export type ArtifactKind =
  | 'markdown_page'
  | 'html_page'
  | 'static_site'
  | 'spa'
  | 'workspace_app'

export type Visibility = 'private' | 'workspace' | 'project' | 'link'

export type EditableVisibility = Visibility

// `project` は所属が project のコンテナの成果物にだけ選べる。inbox の成果物は
// プロジェクトの関係者を継承しないので候補に出さない。
export type ContainerKind = 'project' | 'inbox'

// プロジェクトの公開範囲のベース。'workspace'=社内全員、'private'=関係者のみ。
// visibility='project' の成果物はこのベースを継承する。
export type ProjectBaseVisibility = 'workspace' | 'private'

// プロジェクト関係者の役割。上位は下位を含む（閲覧 ⊂ 投稿 ⊂ 管理）。
export type ProjectShareRole = 'viewer' | 'contributor' | 'manager'

// 能力の昇順。UI の選択肢や比較の基準に使う。
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

export function isVisibility(value: unknown): value is Visibility {
  return (
    value === 'private' ||
    value === 'workspace' ||
    value === 'project' ||
    value === 'link'
  )
}

// 'project' は project コンテナの成果物にだけ意味を持つ。inbox など project 以外
// のコンテナに来たら private に倒し、関係者の継承が起きないようにする。
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
