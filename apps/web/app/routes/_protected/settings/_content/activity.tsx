import type { Route } from './+types/activity'
import type { AuditEventsPageResult } from '~/lib/team-management'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { requireSettingsAdminPage } from '../+lib/settings-admin.server'
import { loadAuditEventsPage } from '~/services/team-management.server'
import { parsePageParam } from '~/lib/pagination'
import ActivityPage from '../+components/activity-page'

// React Router passes loaderData only to a default export declared here.
export default ActivityPage

export function loader({
  request,
  context,
}: Route.LoaderArgs): Promise<AuditEventsPageResult> {
  requireSettingsAdminPage(context)
  const user = requireUser(context)
  return loadAuditEventsPage(
    createDb(),
    user.workspaceId,
    parsePageParam(new URL(request.url).searchParams),
  )
}
