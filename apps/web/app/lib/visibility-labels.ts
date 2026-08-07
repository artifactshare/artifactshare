import type { ProjectBaseVisibility, Visibility } from './shareable-types'

type ShortVisibilityLabelKey =
  | 'table.visibilityPrivate'
  | 'table.visibilityProject'
  | 'table.visibilityWorkspace'
  | 'card.visibility.link'

const SHORT_VISIBILITY_LABEL_KEYS: Record<Visibility, ShortVisibilityLabelKey> =
  {
    private: 'table.visibilityPrivate',
    project: 'table.visibilityProject',
    workspace: 'table.visibilityWorkspace',
    link: 'card.visibility.link',
  }

export function shortVisibilityLabelKey(
  visibility: Visibility,
): ShortVisibilityLabelKey {
  return SHORT_VISIBILITY_LABEL_KEYS[visibility]
}

type ProjectScopeLabelKey =
  | 'project.scopeChip.private'
  | 'project.scopeChip.workspace'

const PROJECT_SCOPE_LABEL_KEYS: Record<
  ProjectBaseVisibility,
  ProjectScopeLabelKey
> = {
  private: 'project.scopeChip.private',
  workspace: 'project.scopeChip.workspace',
}

export function projectScopeLabelKey(
  visibility: ProjectBaseVisibility,
): ProjectScopeLabelKey {
  return PROJECT_SCOPE_LABEL_KEYS[visibility]
}
