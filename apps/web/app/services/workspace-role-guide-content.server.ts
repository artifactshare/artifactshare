import { renderMarkdown } from '~/lib/markdown'
import type { Locale } from '~/i18n/messages'

const modules = import.meta.glob('../guides/workspace-*.md', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

export type WorkspaceRoleGuide = 'owner' | 'admin'

export function getWorkspaceRoleGuideContent(
  role: WorkspaceRoleGuide,
  locale: Locale,
) {
  const suffix = `workspace-${role}.${locale}.md`
  const entry = Object.entries(modules).find(([path]) => path.endsWith(suffix))
  if (!entry) throw new Error(`Missing workspace role guide: ${suffix}`)
  return { locale, html: renderMarkdown(entry[1]) }
}
