import { type Locale } from '~/i18n/messages'
import { APEX_HOST } from '~/lib/hosts'
import { htmlExcerpt } from '~/lib/preview-excerpt'
import type { UpdateDetail, UpdateProduct } from '~/lib/updates-types'
import { socialMeta } from '~/lib/social-meta'

export const UPDATES_EN_PATH = '/updates'
export const UPDATES_JA_PATH = '/ja/updates'
const OG_IMAGE_URL = `https://${APEX_HOST}/og-image`

const VALID_PRODUCTS = new Set<UpdateProduct>([
  'web',
  'cli',
  'agent',
  'mcp',
  'admin',
])

const UPDATES_LIST_META: Record<
  Locale,
  { title: string; description: string }
> = {
  en: {
    title: 'Updates · Artifact Share',
    description:
      'Recent improvements and changes to Artifact Share for Web, CLI, MCP, and AI agent workflows.',
  },
  ja: {
    title: '更新情報 · Artifact Share',
    description:
      'Artifact Share の Web、CLI、MCP、AI エージェント向け機能の改善と変更をお知らせします。',
  },
}

function canonicalForList(locale: Locale): string {
  return locale === 'ja'
    ? `https://${APEX_HOST}${UPDATES_JA_PATH}`
    : `https://${APEX_HOST}${UPDATES_EN_PATH}`
}

function canonicalForEntry(slug: string, locale: Locale): string {
  const path =
    locale === 'ja'
      ? `${UPDATES_JA_PATH}/${slug}`
      : `${UPDATES_EN_PATH}/${slug}`
  return `https://${APEX_HOST}${path}`
}

function ogImageForEntry(slug: string, locale: Locale): string {
  const path =
    locale === 'ja'
      ? `${UPDATES_JA_PATH}/${slug}/og-image`
      : `${UPDATES_EN_PATH}/${slug}/og-image`
  return `https://${APEX_HOST}${path}`
}

export function parseProductFilter(
  value: string | null,
): UpdateProduct | undefined {
  if (!value || !VALID_PRODUCTS.has(value as UpdateProduct)) {
    return undefined
  }
  return value as UpdateProduct
}

export function updatesListMeta(locale: Locale) {
  const listMeta = UPDATES_LIST_META[locale]
  const canonical = canonicalForList(locale)
  return [
    { title: listMeta.title },
    { name: 'description', content: listMeta.description },
    { tagName: 'link', rel: 'canonical', href: canonical },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'en',
      href: `https://${APEX_HOST}${UPDATES_EN_PATH}`,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: `https://${APEX_HOST}${UPDATES_JA_PATH}`,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: `https://${APEX_HOST}${UPDATES_EN_PATH}`,
    },
    ...socialMeta({
      title: listMeta.title,
      description: listMeta.description,
      url: canonical,
      image: OG_IMAGE_URL,
    }),
  ]
}

export function updateOgDescription(bodyHtml: string, maxChars = 160): string {
  return htmlExcerpt(bodyHtml, maxChars)
}

export function updatesDetailMeta(entry: UpdateDetail, locale: Locale) {
  const canonical = canonicalForEntry(entry.slug, locale)
  const description = updateOgDescription(entry.bodyHtml)
  const pageTitle = `${entry.title} · Artifact Share`
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: entry.title,
    datePublished: entry.date,
    inLanguage: locale === 'ja' ? 'ja' : 'en',
  }

  return [
    { title: pageTitle },
    { name: 'description', content: description },
    { tagName: 'link', rel: 'canonical', href: canonical },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'en',
      href: canonicalForEntry(entry.slug, 'en'),
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: canonicalForEntry(entry.slug, 'ja'),
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: canonicalForEntry(entry.slug, 'en'),
    },
    { 'script:ld+json': structuredData },
    ...socialMeta({
      title: entry.title,
      description,
      url: canonical,
      image: ogImageForEntry(entry.slug, locale),
      imageAlt: entry.title,
    }),
  ]
}
