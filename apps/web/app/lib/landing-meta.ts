import { MESSAGES } from '~/i18n/messages'
import { APEX_HOST } from '~/lib/hosts'
import { socialMeta } from '~/lib/social-meta'

const HOME_URL = `https://${APEX_HOST}/`
const JA_HOME_URL = `https://${APEX_HOST}/ja`
const HOME_OG_IMAGE_URL = `https://${APEX_HOST}/og-image`
const JA_HOME_OG_IMAGE_URL = `https://${APEX_HOST}/ja/og-image`
const HOME_OG_DESCRIPTION =
  'Share AI-made HTML and Markdown as browser links. Use the CLI with Codex, Claude Code, or Cursor Agent, or remote MCP with Claude, ChatGPT, Cursor chat, or Claude Cowork.'

export function landingMeta(locale: 'en' | 'ja') {
  const canonical = locale === 'ja' ? JA_HOME_URL : HOME_URL
  const ogImage = locale === 'ja' ? JA_HOME_OG_IMAGE_URL : HOME_OG_IMAGE_URL
  const description =
    locale === 'ja'
      ? `${MESSAGES.ja['lp.title']} ${MESSAGES.ja['lp.sub']}`
      : HOME_OG_DESCRIPTION
  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: 'Artifact Share',
    alternateName: 'Artifact Share',
    url: canonical,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description,
    image: ogImage,
    provider: {
      '@type': 'Organization',
      name: 'TechTalk, Inc.',
      url: 'https://techtalk.jp',
    },
  }

  return [
    { title: 'Artifact Share' },
    { name: 'description', content: description },
    { name: 'application-name', content: 'Artifact Share' },
    { tagName: 'link', rel: 'canonical', href: canonical },
    { tagName: 'link', rel: 'alternate', hrefLang: 'en', href: HOME_URL },
    { tagName: 'link', rel: 'alternate', hrefLang: 'ja', href: JA_HOME_URL },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: HOME_URL,
    },
    { 'script:ld+json': structuredData },
    ...socialMeta({
      title: 'Artifact Share',
      description,
      url: canonical,
      image: ogImage,
    }),
  ]
}
