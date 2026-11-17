import type { Locale } from '~/i18n/messages'
import { APEX_HOST } from './hosts'

const BASE = `https://${APEX_HOST}`
const BASE_PATH = '/guides/search'

export function searchGuideMeta(locale: Locale) {
  const canonical = locale === 'ja' ? `/ja${BASE_PATH}` : BASE_PATH
  const title = locale === 'ja' ? '検索ガイド' : 'Search guide'
  const description =
    locale === 'ja'
      ? '検索の開き方、所有者・プロジェクト・期間での絞り込み、候補の操作、検索対象を説明します。'
      : 'How to open search, filter by owner, project, and period, use suggestions, and understand which files appear.'
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
