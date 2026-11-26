import { Stack } from '~/components/layout/stack'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import { Pager } from '~/components/form/pager'
import { useT } from '~/hooks/use-t'
import {
  INVENTORY_PAGE_SIZE,
  type InventoryProjectEntry,
} from '~/lib/team-management'
import { ProjectsTable } from './projects-table'

export interface InventoryProjectsLoaderData {
  projects: { projects: InventoryProjectEntry[]; total: number; page: number }
}

export default function ProjectsPage({
  loaderData,
}: {
  loaderData: InventoryProjectsLoaderData
}) {
  const { t, locale } = useT()
  const { projects } = loaderData
  return (
    <Stack gap="3">
      <TeamMutedParagraph>
        {t('team.inventory.projects.body')}
      </TeamMutedParagraph>
      <ProjectsTable rows={projects.projects} locale={locale} />
      <Pager
        page={projects.page}
        total={projects.total}
        pageSize={INVENTORY_PAGE_SIZE}
        labels={{
          range: 'team.inventory.range',
          prev: 'team.inventory.page.prev',
          next: 'team.inventory.page.next',
        }}
        hrefFor={(page) =>
          `/settings/inventory/projects${page > 1 ? `?page=${page}` : ''}`
        }
      />
    </Stack>
  )
}
