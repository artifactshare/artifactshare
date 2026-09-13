import { GuideStaticPage } from '~/components/app/guide-static-page'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { workspaceRoleGuideMeta } from '~/lib/workspace-role-guide-meta'
import { getWorkspaceRoleGuideContent } from '~/services/workspace-role-guide-content.server'
import type { Route } from './+types/guides.workspace-admin'
import type { ScreenSpec } from '~/types/screen'

export const screen = {
  id: 'guides-workspace-admin',
  route: {
    en: '/guides/workspace-admin',
    ja: '/ja/guides/workspace-admin',
  },
  auth: 'anonymous',
  loop: 'support',
  metric: 'ワークスペース運用の定着を支える',
  role: '管理者向けの運用方法を案内する',
  primaryAction: 'ガイドを読む',
  states: [
    {
      id: 'default',
      description: '管理者ガイド',
      setup: {},
    },
  ],
} satisfies ScreenSpec

export function loader() {
  return getWorkspaceRoleGuideContent('admin', DEFAULT_LOCALE)
}
export function meta({ loaderData }: Route.MetaArgs) {
  return workspaceRoleGuideMeta('admin', loaderData?.locale ?? DEFAULT_LOCALE)
}
export default function WorkspaceAdminGuide({
  loaderData,
}: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/workspace-admin" />
}
