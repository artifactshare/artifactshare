import { Link } from 'react-router'
import { inlineLinkClassName } from '~/components/form/settings-text-styles'
import { Stack } from '~/components/layout/stack'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import { Pager } from '~/components/form/pager'
import { useT } from '~/hooks/use-t'
import {
  INVENTORY_PAGE_SIZE,
  type InventoryArtifactEntry,
  type InventoryArtifactsFilters,
} from '~/lib/team-management'
import { ArtifactFilters } from './artifact-filters'
import { ArtifactsTable } from './artifacts-table'

export interface InventoryArtifactsLoaderData {
  artifacts: {
    artifacts: InventoryArtifactEntry[]
    total: number
    page: number
  }
  filters: InventoryArtifactsFilters
}

export default function ArtifactsPage({
  loaderData,
}: {
  loaderData: InventoryArtifactsLoaderData
}) {
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
