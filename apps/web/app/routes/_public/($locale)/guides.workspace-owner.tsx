import { GuideStaticPage } from '~/components/app/guide-static-page'
import { resolvePublicRouteLocale } from '~/lib/public-route-locale'
import { workspaceRoleGuideMeta } from '~/lib/workspace-role-guide-meta'
import { getWorkspaceRoleGuideContent } from '~/services/workspace-role-guide-content.server'
import type { Route } from './+types/guides.workspace-owner'

export function loader({ params }: Route.LoaderArgs) {
  return getWorkspaceRoleGuideContent(
    'owner',
    resolvePublicRouteLocale(params.locale),
  )
}
export function meta({ loaderData }: Route.MetaArgs) {
  return workspaceRoleGuideMeta('owner', loaderData?.locale ?? 'en')
}
export default function WorkspaceOwnerGuide({
  loaderData,
}: Route.ComponentProps) {
  return <GuideStaticPage {...loaderData} path="/guides/workspace-owner" />
}
