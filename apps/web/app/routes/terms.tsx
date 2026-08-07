import { GuideStaticPage } from '~/components/app/guide-static-page'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { APEX_HOST } from '~/lib/hosts'
import { socialMeta } from '~/lib/social-meta'
import { termsHtml } from '~/services/legal-content.server'
import type { Route } from './+types/terms'

const EN_CANONICAL = `https://${APEX_HOST}/terms`
const JA_CANONICAL = `https://${APEX_HOST}/ja/terms`
const OG_IMAGE_URL = `https://${APEX_HOST}/og-image`

const TERMS_META: Record<Locale, { title: string; description: string }> = {
  en: {
    title: 'Terms of Service · Artifact Share',
    description:
      'Terms of Service for Artifact Share — acceptable use, your content, takedown procedures, and limitations of liability.',
  },
  ja: {
    title: '利用規約 · Artifact Share',
    description:
      'Artifact Share の利用規約 — 許容される利用、コンテンツの扱い、削除手続き、責任の制限。',
  },
}

export function termsMeta(locale: Locale) {
  const m = TERMS_META[locale]
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
  return { html: termsHtml(DEFAULT_LOCALE) }
}

export function meta() {
  return termsMeta(DEFAULT_LOCALE)
}

export function TermsPage({ html, locale }: { html: string; locale: Locale }) {
  return <GuideStaticPage html={html} locale={locale} path="/terms" />
}

export default function TermsRoute({ loaderData }: Route.ComponentProps) {
  return <TermsPage html={loaderData.html} locale={DEFAULT_LOCALE} />
}
