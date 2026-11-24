import { GuideStaticPage } from '~/components/app/guide-static-page'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { workspaceRoleGuideMeta } from '~/lib/workspace-role-guide-meta'
import { getWorkspaceRoleGuideContent } from '~/services/workspace-role-guide-content.server'
import type { Route } from './+types/guides.workspace-admin'

export function loader({ params }: Route.LoaderArgs) {
  return getWorkspaceRoleGuideContent(
    'admin',
    resolvePublicRouteLocale(params.locale),
  )
}
export function meta({ loaderData }: Route.MetaArgs) {
  return workspaceRoleGuideMeta('admin', loaderData?.locale ?? 'en')
}
export default function WorkspaceAdminGuide({
  loaderData,
}: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/workspace-admin" />
}
