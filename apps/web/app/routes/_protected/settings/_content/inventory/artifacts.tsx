import { inlineLinkClassName } from '~/components/form/settings-text-styles'
import { Link } from 'react-router'
import type { Route } from './+types/artifacts'
import { Stack } from '~/components/layout/stack'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import { useT } from '~/hooks/use-t'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  loadWorkspaceInventoryArtifactsPage,
  parseInventoryArtifactsFilters,
} from '~/services/team-management.server'
import { requireSettingsAdminPage } from '../../+lib/settings-admin.server'
import { ArtifactFilters } from './+components/artifact-filters'
import { ArtifactsTable } from './+components/artifacts-table'
import { Pager } from '~/components/form/pager'
import { INVENTORY_PAGE_SIZE } from '~/lib/team-management'
export async function loader({ request, context }: Route.LoaderArgs) {
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
export default function ArtifactsPage({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const { t, locale } = useT()
  const { artifacts, filters } = loaderData
  return (
    <Stack gap="3">
      <TeamMutedParagraph>
        {t('team.inventory.artifacts.body')}
      </TeamMutedParagraph>
      <ArtifactFilters filters={filters} />
      <ArtifactsTable rows={artifacts.artifacts} locale={locale} />
      <Pager
        page={artifacts.page}
        total={artifacts.total}
        pageSize={INVENTORY_PAGE_SIZE}
        labels={{
          range: 'team.inventory.range',
          prev: 'team.inventory.page.prev',
          next: 'team.inventory.page.next',
        }}
        hrefFor={(page) => {
          const params = new URLSearchParams()
          if (filters.visibility !== 'all')
            params.set('visibility', filters.visibility)
          if (filters.sort !== 'updated') params.set('sort', filters.sort)
          if (page > 1) params.set('page', String(page))
          const query = params.toString()
          return `/settings/inventory/artifacts${query ? `?${query}` : ''}`
        }}
      />
      <p>
        <Link className={inlineLinkClassName} to="/settings#removed-members">
          {t('team.removedMembers')}
        </Link>
      </p>
    </Stack>
  )
}
