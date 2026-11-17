import { renderMarkdownBody as renderMarkdown } from '~/lib/markdown-renderer.server'
import type { Locale } from '~/i18n/messages'

const modules = import.meta.glob('../guides/search.*.md', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

export function getSearchGuideContent(locale: Locale) {
  const suffix = `search.${locale}.md`
  const entry = Object.entries(modules).find(([path]) => path.endsWith(suffix))
  if (!entry) throw new Error(`Missing search guide: ${suffix}`)
  return { locale, html: renderMarkdown(entry[1]) }
}
