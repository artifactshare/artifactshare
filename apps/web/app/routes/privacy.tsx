import { GuideStaticPage } from '~/components/app/guide-static-page'
import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import { APEX_HOST } from '~/lib/hosts'
import { socialMeta } from '~/lib/social-meta'
import { privacyHtml } from '~/services/legal-content.server'
import type { Route } from './+types/privacy'

const EN_CANONICAL = `https://${APEX_HOST}/privacy`
const JA_CANONICAL = `https://${APEX_HOST}/ja/privacy`
const OG_IMAGE_URL = `https://${APEX_HOST}/og-image`

const PRIVACY_META: Record<Locale, { title: string; description: string }> = {
  en: {
    title: 'Privacy Policy · Artifact Share',
    description: 'How Artifact Share collects, uses, and protects your data.',
  },
  ja: {
    title: 'プライバシーポリシー · Artifact Share',
    description:
      'Artifact Share が個人情報をどのように収集、利用、保護するか。',
  },
}

export function privacyMeta(locale: Locale) {
  const m = PRIVACY_META[locale]
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
  return { html: privacyHtml(DEFAULT_LOCALE) }
}

export function meta() {
  return privacyMeta(DEFAULT_LOCALE)
}

export function PrivacyPage({
  html,
  locale,
}: {
  html: string
  locale: Locale
}) {
  return <GuideStaticPage html={html} locale={locale} path="/privacy" />
}

export default function PrivacyRoute({ loaderData }: Route.ComponentProps) {
  return <PrivacyPage html={loaderData.html} locale={DEFAULT_LOCALE} />
}
