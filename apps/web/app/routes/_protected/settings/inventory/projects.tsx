import type { Route } from './+types/projects'
import { Stack } from '~/components/layout/stack'
import { TeamMutedParagraph } from '~/components/form/team-muted'
import { useT } from '~/hooks/use-t'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { loadWorkspaceInventoryProjectsPage } from '~/services/team-management.server'
import { INVENTORY_PAGE_SIZE } from '~/lib/team-management'
import { requireInventoryAccess } from '~/services/access.server'
import { ProjectsTable } from './+components/projects-table'
import { Pager } from '~/components/form/pager'
import { parsePageParam } from '~/lib/pagination'
export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  await requireInventoryAccess(db, user)
  const raw = parsePageParam(new URL(request.url).searchParams)
  return {
    projects: await loadWorkspaceInventoryProjectsPage(
      db,
      user.workspaceId,
      Number.isFinite(raw) ? raw : 1,
    ),
  }
}
export default function ProjectsPage({ loaderData }: Route.ComponentProps) {
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
