import { GuideStaticPage } from '~/components/app/guide-static-page'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { APEX_HOST } from '~/lib/hosts'
import { socialMeta } from '~/lib/social-meta'
import { tokushohoHtml } from '~/services/legal-content.server'
import type { Route } from './+types/tokushoho'

const EN_CANONICAL = `https://${APEX_HOST}/tokushoho`
const JA_CANONICAL = `https://${APEX_HOST}/ja/tokushoho`
const OG_IMAGE_URL = `https://${APEX_HOST}/og-image`

const TOKUSHOHO_META: Record<Locale, { title: string; description: string }> = {
  en: {
    title: 'Commercial Disclosure · Artifact Share',
    description:
      'Legally required disclosure under the Japanese Specified Commercial Transactions Act.',
  },
  ja: {
    title: '特定商取引法に基づく表記 · Artifact Share',
    description: '特定商取引法に基づく販売事業者情報の開示。',
  },
}

export function tokushohoMeta(locale: Locale) {
  const m = TOKUSHOHO_META[locale]
  const canonical = locale === 'ja' ? JA_CANONICAL : EN_CANONICAL
  return [
    { title: m.title },
    { name: 'description', content: m.description },
    { tagName: 'link', rel: 'canonical', href: canonical },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'en',
      href: EN_CANONICAL,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: JA_CANONICAL,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: EN_CANONICAL,
    },
    ...socialMeta({
      title: m.title,
      description: m.description,
      url: canonical,
      image: OG_IMAGE_URL,
    }),
  ]
}

export function loader() {
  return { html: tokushohoHtml(DEFAULT_LOCALE) }
}

export function meta() {
  return tokushohoMeta(DEFAULT_LOCALE)
}

export function TokushohoPage({
  html,
  locale,
}: {
  html: string
  locale: Locale
}) {
  return <GuideStaticPage html={html} locale={locale} path="/tokushoho" />
}

export default function TokushohoRoute({ loaderData }: Route.ComponentProps) {
  return <TokushohoPage html={loaderData.html} locale={DEFAULT_LOCALE} />
}
