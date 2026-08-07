import type { Locale } from '~/i18n/messages'
import { APEX_HOST } from './hosts'

const BASE = `https://${APEX_HOST}`
const BASE_PATH = '/guides/link-sharing'

export function linkSharingGuideMeta(locale: Locale) {
  const canonical = locale === 'ja' ? `/ja${BASE_PATH}` : BASE_PATH
  const title = locale === 'ja' ? 'リンク共有ガイド' : 'Link sharing guide'
  const description =
    locale === 'ja'
      ? 'リンク共有の設定、期限切れ、Free・Plus・Teamの違い、Web・CLI・MCPでの使い方を説明します。'
      : 'How link sharing works, how expiration is managed, and how to use it on the web, CLI, and MCP across Free, Plus, and Team.'
  return [
    { title },
    { name: 'description', content: description },
    { tagName: 'link', rel: 'canonical', href: `${BASE}${canonical}` },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'en',
      href: `${BASE}${BASE_PATH}`,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: `${BASE}/ja${BASE_PATH}`,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: `${BASE}${BASE_PATH}`,
    },
  ]
}
