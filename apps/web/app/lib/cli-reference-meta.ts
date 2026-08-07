import type { Locale } from '~/i18n/messages'
import { cliReferenceContent } from './cli-reference-content'
import { APEX_HOST } from './hosts'
import { socialMeta } from './social-meta'

export const CLI_REFERENCE_EN_CANONICAL = `https://${APEX_HOST}/guides/cli`
export const CLI_REFERENCE_JA_CANONICAL = `https://${APEX_HOST}/ja/guides/cli`

export function cliReferenceMeta(locale: Locale) {
  const og = cliReferenceContent(locale).og
  const canonical =
    locale === 'ja' ? CLI_REFERENCE_JA_CANONICAL : CLI_REFERENCE_EN_CANONICAL
  return [
    { title: og.title },
    { name: 'description', content: og.description },
    { tagName: 'link', rel: 'canonical', href: canonical },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'en',
      href: CLI_REFERENCE_EN_CANONICAL,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: CLI_REFERENCE_JA_CANONICAL,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: CLI_REFERENCE_EN_CANONICAL,
    },
    ...socialMeta({
      title: og.title,
      description: og.description,
      url: canonical,
      image: `https://${APEX_HOST}/og-image`,
      imageAlt: og.title,
    }),
  ]
}
