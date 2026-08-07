import { GuideStaticPage } from '~/components/app/guide-static-page'
import { workspaceRoleGuideMeta } from '~/lib/workspace-role-guide-meta'
import { getWorkspaceRoleGuideContent } from '~/services/workspace-role-guide-content.server'
import type { Route } from './+types/ja.guides.workspace-owner'

export function loader() {
  return getWorkspaceRoleGuideContent('owner', 'ja')
}
export function meta({ loaderData }: Route.MetaArgs) {
  return workspaceRoleGuideMeta('owner', loaderData?.locale ?? 'ja')
}
export default function JapaneseWorkspaceOwnerGuide({
  loaderData,
}: Route.ComponentProps) {
  return (
    <GuideStaticPage
      {...loaderData}
      locale="ja"
      path="/guides/workspace-owner"
    />
  )
}
