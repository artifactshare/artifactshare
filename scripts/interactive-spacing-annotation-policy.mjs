import { relative } from 'node:path'

export const INTERACTIVE_SPACING_ANNOTATION = 'data-gap-audit-composite'
export const SHARED_UI_COMPONENT_DIRECTORY = 'apps/web/app/components/ui/'

export function isAllowedInteractiveSpacingSource(file, root) {
  const path = relative(root, file).split('\\').join('/')
  return path.startsWith(SHARED_UI_COMPONENT_DIRECTORY)
}
