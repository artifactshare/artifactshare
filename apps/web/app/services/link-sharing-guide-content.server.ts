import { renderMarkdownBody as renderMarkdown } from '~/lib/markdown-renderer.server'
import type { Locale } from '~/i18n/messages'

const modules = import.meta.glob('../guides/link-sharing.*.md', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

export function getLinkSharingGuideContent(locale: Locale) {
  const suffix = `link-sharing.${locale}.md`
  const entry = Object.entries(modules).find(([path]) => path.endsWith(suffix))
  if (!entry) throw new Error(`Missing link sharing guide: ${suffix}`)
  return { locale, html: renderMarkdown(entry[1]) }
}
