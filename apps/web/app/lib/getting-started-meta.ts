import type { Locale } from '~/i18n/messages'
import { gettingStartedCopy } from '~/lib/getting-started-content'
import { APEX_HOST } from '~/lib/hosts'
import { socialMeta } from '~/lib/social-meta'

const EN_CANONICAL = `https://${APEX_HOST}/start`
const JA_CANONICAL = `https://${APEX_HOST}/ja/start`
const OG_IMAGE_URL = `https://${APEX_HOST}/og-image`

export function gettingStartedMeta(locale: Locale) {
  const copy = gettingStartedCopy(locale)
  const canonical = locale === 'ja' ? JA_CANONICAL : EN_CANONICAL
  return [
    { title: copy.heading },
    { name: 'description', content: copy.lead },
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
      title: copy.heading,
      description: copy.lead,
      url: canonical,
      image: OG_IMAGE_URL,
      imageAlt: copy.heading,
    }),
  ]
}
