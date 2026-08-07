import type { Locale } from '~/i18n/messages'
import { APEX_HOST } from './hosts'

const BASE = `https://${APEX_HOST}`

export function workspaceRoleGuideMeta(
  role: 'owner' | 'admin',
  locale: Locale,
) {
  const basePath = `/guides/workspace-${role}`
  const canonical = locale === 'ja' ? `/ja${basePath}` : basePath
  const title =
    locale === 'ja'
      ? role === 'owner'
        ? 'ワークスペースオーナーガイド'
        : 'ワークスペース管理者ガイド'
      : role === 'owner'
        ? 'Workspace owner guide'
        : 'Workspace admin guide'
  const description =
    locale === 'ja'
      ? role === 'owner'
        ? 'ワークスペースオーナーの責任と、オーナーだけが行える手続きを説明します。'
        : 'ワークスペース管理者の日常業務と、オーナーへ依頼する手続きを説明します。'
      : role === 'owner'
        ? 'Responsibilities and owner-only procedures for a workspace owner.'
        : 'Day-to-day member management for workspace admins and owner-only procedures to request.'
  return [
    { title },
    { name: 'description', content: description },
    { tagName: 'link', rel: 'canonical', href: `${BASE}${canonical}` },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'en',
      href: `${BASE}${basePath}`,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'ja',
      href: `${BASE}/ja${basePath}`,
    },
    {
      tagName: 'link',
      rel: 'alternate',
      hrefLang: 'x-default',
      href: `${BASE}${basePath}`,
    },
  ]
}
