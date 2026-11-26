import type { Route } from './+types/projects'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { loadWorkspaceInventoryProjectsPage } from '~/services/team-management.server'
import { requireSettingsAdminPage } from '../../+lib/settings-admin.server'
import { parsePageParam } from '~/lib/pagination'
import ProjectsPage, {
  type InventoryProjectsLoaderData,
} from './+components/projects-page'

// React Router passes loaderData only to a default export declared here.
export default ProjectsPage

export async function loader({
  request,
  context,
}: Route.LoaderArgs): Promise<InventoryProjectsLoaderData> {
  requireSettingsAdminPage(context)
  const user = requireUser(context)
  const db = createDb()
  const raw = parsePageParam(new URL(request.url).searchParams)
  return {
    projects: await loadWorkspaceInventoryProjectsPage(
      db,
      user.workspaceId,
      Number.isFinite(raw) ? raw : 1,
    ),
  }
}
