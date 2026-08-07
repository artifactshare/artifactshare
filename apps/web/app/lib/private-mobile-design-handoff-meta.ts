import { APEX_HOST } from './hosts'
import { privateMobileDesignHandoffContent } from './private-mobile-design-handoff-content'
import type { Locale } from '~/i18n/messages'
import { socialMeta } from './social-meta'

export const PRIVATE_HANDOFF_EN_CANONICAL = `https://${APEX_HOST}/guides/private-mobile-design-handoff`
export const PRIVATE_HANDOFF_JA_CANONICAL = `https://${APEX_HOST}/ja/guides/private-mobile-design-handoff`

export function privateMobileDesignHandoffMeta(locale: Locale) {
  const content = privateMobileDesignHandoffContent(locale)
  const canonical =
    locale === 'ja'
      ? PRIVATE_HANDOFF_JA_CANONICAL
      : PRIVATE_HANDOFF_EN_CANONICAL
  const image = `https://${APEX_HOST}${content.canonicalPath}/og-image`
  return [
    { title: content.title },
    { name: 'description', content: content.description },
    { tagName: 'link', rel: 'canonical', href: canonical },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'en',
      href: PRIVATE_HANDOFF_EN_CANONICAL,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: PRIVATE_HANDOFF_JA_CANONICAL,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: PRIVATE_HANDOFF_EN_CANONICAL,
    },
    { property: 'og:locale', content: locale === 'ja' ? 'ja_JP' : 'en_US' },
    {
      property: 'og:locale:alternate',
      content: locale === 'ja' ? 'en_US' : 'ja_JP',
    },
    ...socialMeta({
      title: content.og.title,
      description: content.og.description,
      url: canonical,
      image,
      imageAlt: content.og.imageAlt,
    }),
  ]
}
