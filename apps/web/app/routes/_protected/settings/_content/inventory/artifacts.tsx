import type { Route } from './+types/artifacts'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  loadWorkspaceInventoryArtifactsPage,
  parseInventoryArtifactsFilters,
} from '~/services/team-management.server'
import { requireSettingsAdminPage } from '../../+lib/settings-admin.server'
import ArtifactsPage, {
  type InventoryArtifactsLoaderData,
} from './+components/artifacts-page'

// React Router passes loaderData only to a default export declared here.
export default ArtifactsPage

export async function loader({
  request,
  context,
}: Route.LoaderArgs): Promise<InventoryArtifactsLoaderData> {
  requireSettingsAdminPage(context)
  const user = requireUser(context)
  const db = createDb()
  const filters = parseInventoryArtifactsFilters(
    new URL(request.url).searchParams,
  )
  return {
    artifacts: await loadWorkspaceInventoryArtifactsPage(
      db,
      user.workspaceId,
      filters,
    ),
    filters,
  }
}
