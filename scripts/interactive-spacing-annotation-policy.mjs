import { relative } from 'node:path'

export const INTERACTIVE_SPACING_ANNOTATION = 'data-gap-audit-composite'
export const ALLOWED_INTERACTIVE_SPACING_SOURCES = new Set([
  'apps/web/app/components/ui/input-group.tsx',
  'apps/web/app/components/ui/segmented-control.tsx',
])

export function isAllowedInteractiveSpacingSource(file, root) {
  const path = relative(root, file).split('\\').join('/')
  return ALLOWED_INTERACTIVE_SPACING_SOURCES.has(path)
}
