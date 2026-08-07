import { renderMarkdown } from '~/lib/markdown'
import type { Locale } from '~/i18n/messages'

const modules = import.meta.glob(
  '../guides/private-mobile-design-handoff.*.md',
  {
    query: '?raw',
    eager: true,
    import: 'default',
  },
) as Record<string, string>

export interface PrivateMobileDesignHandoffRenderedContent {
  locale: Locale
  source: string
  html: string
}

export function getPrivateMobileDesignHandoffContent(
  locale: Locale,
): PrivateMobileDesignHandoffRenderedContent {
  const suffix = `.${locale}.md`
  const entry = Object.entries(modules).find(([path]) => path.endsWith(suffix))
  if (!entry) throw new Error(`Missing handoff guide for locale: ${locale}`)
  const source = entry[1]
  return { locale, source, html: renderMarkdown(source) }
}
