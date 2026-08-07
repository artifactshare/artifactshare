import { GuideStaticPage } from '~/components/app/guide-static-page'
import { DEFAULT_LOCALE } from '~/i18n/messages'
import { workspaceRoleGuideMeta } from '~/lib/workspace-role-guide-meta'
import { getWorkspaceRoleGuideContent } from '~/services/workspace-role-guide-content.server'
import type { Route } from './+types/guides.workspace-owner'

export function loader() {
  return getWorkspaceRoleGuideContent('owner', DEFAULT_LOCALE)
}
export function meta({ loaderData }: Route.MetaArgs) {
  return workspaceRoleGuideMeta('owner', loaderData?.locale ?? DEFAULT_LOCALE)
}
export default function WorkspaceOwnerGuide({
  loaderData,
}: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/workspace-owner" />
}
