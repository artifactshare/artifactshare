import { APEX_HOST } from '~/lib/hosts'
import { getVisibleUpdates } from '~/services/updates-visibility.server'
import { getPublicPagePairs } from '~/lib/public-pages'

const BASE = `https://${APEX_HOST}`

interface I18nPage {
  en: string
  ja: string
}

const i18nPages: I18nPage[] = getPublicPagePairs()

const XML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => XML_ESCAPE_MAP[character]!)
}

function absoluteUrl(path: string): string {
  return escapeXml(`${BASE}${path}`)
}

function i18nUrlEntries(page: I18nPage, lastmod?: string): string[] {
  const lastmodEntry = lastmod
    ? `    <lastmod>${escapeXml(lastmod)}</lastmod>`
    : null
  const entries: string[] = []
  for (const loc of [page.en, page.ja]) {
    entries.push(
      '  <url>',
      `    <loc>${absoluteUrl(loc)}</loc>`,
      ...(lastmodEntry ? [lastmodEntry] : []),
      `    <xhtml:link rel="alternate" hreflang="en" href="${absoluteUrl(page.en)}" />`,
      `    <xhtml:link rel="alternate" hreflang="ja" href="${absoluteUrl(page.ja)}" />`,
      `    <xhtml:link rel="alternate" hreflang="x-default" href="${absoluteUrl(page.en)}" />`,
      '  </url>',
    )
  }
  return entries
}

export async function loader() {
  const visibleEntries = await getVisibleUpdates('en')
  const updatePages = visibleEntries.map((entry) => ({
    page: {
      en: `/updates/${entry.slug}`,
      ja: `/ja/updates/${entry.slug}`,
    },
    lastmod: entry.date,
  }))

  const body = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"',
    '        xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...i18nPages.flatMap((page) => i18nUrlEntries(page)),
    ...updatePages.flatMap(({ page, lastmod }) =>
      i18nUrlEntries(page, lastmod),
    ),
    '</urlset>',
    '',
  ].join('\n')

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  })
}
