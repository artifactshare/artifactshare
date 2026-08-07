import { useState, type ReactNode } from 'react'
import { Link, useRevalidator } from 'react-router'
import { IconStack2 as Layers } from '@tabler/icons-react'
import type { Route } from './+types/projects.archived'
import { Inline } from '~/components/layout/inline'
import {
  DeleteProjectDialog,
  UnarchiveProjectButton,
} from '~/components/app/project-manage-dialogs'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import { Button } from '~/components/ui/button'
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '~/components/ui/empty'
import { formatRelative } from '~/lib/datetime'
import { toUserInfo, type UserInfo } from '~/lib/user'
import { useT } from '~/hooks/use-t'
import { requireUser } from '~/middleware/context'
import { isTeamWorkspaceAdmin } from '~/services/access.server'
import { createDb } from '~/services/db.server'
import {
  listArchivedWorkspaceProjects,
  type ProjectSummary,
} from '~/services/projects.server'
import {
  projectContextClassName,
  projectDetailActionsClassName,
  projectDetailDescClassName,
  projectDetailHeadClassName,
  projectDetailH1ClassName,
} from '~/components/app/project-detail-styles'
import { Topbar } from '../_home/+components/topbar'
import { BottomTabBar } from '../_home/+components/bottom-tab-bar'
import type { JoinedProjectNav } from '../_home/+components/primary-nav'
import { listMainClassName } from '~/components/app/page-shell-styles'
import { listJoinedProjectsForDropdown } from '~/services/project-membership.server'

type LoaderData = {
  projects: ProjectSummary[]
  user: UserInfo
  userId: string
  isAdmin: boolean
  workspaceId: string
  workspaceName: string
  joinedProjects: JoinedProjectNav[]
}

export async function loader({
  context,
}: Route.LoaderArgs): Promise<LoaderData> {
  const user = requireUser(context)

  const db = createDb()
  const [workspace, projects, isAdmin, joinedProjects] = await Promise.all([
    db
      .selectFrom('workspaces')
      .select(['name', 'hd'])
      .where('id', '=', user.workspaceId)
      .executeTakeFirst(),
    listArchivedWorkspaceProjects(db, user.workspaceId, user),
    isTeamWorkspaceAdmin(db, user, user.workspaceId),
    listJoinedProjectsForDropdown(db, user, 5)
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          newCount: row.newCount,
          workspaceName: row.workspaceName,
        })),
      )
      .catch(() => []),
  ])

  return {
    projects,
    user: toUserInfo(user),
    userId: user.id,
    isAdmin,
    workspaceId: user.workspaceId,
    workspaceName: workspace?.name ?? workspace?.hd ?? 'Files',
    joinedProjects,
  }
}

export default function ArchivedProjects({ loaderData }: Route.ComponentProps) {
  const { t, locale } = useT()
  const revalidator = useRevalidator()
  const { projects, userId, isAdmin, workspaceId, workspaceName } = loaderData
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null)

  const refresh = () => revalidator.revalidate()

  return (
    <>
      <Topbar
        workspaceName={workspaceName}
        user={loaderData.user}
        joinedProjects={loaderData.joinedProjects}
      />
      <main className={listMainClassName}>
        <PageBreadcrumb aria-label={t('project.location')}>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/">{workspaceName}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/projects">{t('project.projects')}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t('projectArchive.breadcrumb')}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </PageBreadcrumb>

        <section className={projectContextClassName}>
          <div className={projectDetailHeadClassName}>
            <div className="min-w-0">
              <h1 className={projectDetailH1ClassName}>
                {t('projectArchive.listTitle')}
              </h1>
              <p className={projectDetailDescClassName}>
                {t('projectArchive.listDescription')}
              </p>
            </div>
            <div className={projectDetailActionsClassName}>
              <Button asChild variant="outline" size="sm">
                <Link to="/projects">{t('projectArchive.backToProjects')}</Link>
              </Button>
            </div>
          </div>
        </section>

        {projects.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon" aria-hidden="true">
                <Layers size={16} />
              </EmptyMedia>
              <EmptyTitle role="heading" aria-level={2}>
                {t('projectArchive.emptyTitle')}
              </EmptyTitle>
              <EmptyDescription>
                {t('projectArchive.emptyBody')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="mt-2 list-none p-0">
            {projects.map((project) => {
              const canManage = isAdmin || project.createdById === userId
              return (
                <ArchivedProjectRow key={project.id}>
                  <span
                    className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center rounded-md"
                    aria-hidden="true"
                  >
                    <Layers size={16} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-sm">
                      {project.name}
                    </strong>
                    <small className="text-muted-foreground block truncate text-xs">
                      {t('project.fileCount', { count: project.fileCount })}
                      {project.archivedAt
                        ? ` · ${t('projectArchive.archivedAt', {
                            time: formatRelative(project.archivedAt, locale),
                          })}`
                        : ''}
                    </small>
                  </div>
                  {canManage ? (
                    <div className="max-nav:flex-col max-nav:items-stretch flex shrink-0 gap-2">
                      <UnarchiveProjectButton
                        projectId={project.id}
                        projectName={project.name}
                        onSuccess={refresh}
                      >
                        {t('projectArchive.unarchive')}
                      </UnarchiveProjectButton>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDeleteTarget(project)}
                      >
                        {t('project.delete')}
                      </Button>
                    </div>
                  ) : null}
                </ArchivedProjectRow>
              )
            })}
          </ul>
        )}
      </main>

      {deleteTarget ? (
        <DeleteProjectDialog
          open={deleteTarget !== null}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null)
          }}
          projectId={deleteTarget.id}
          projectName={deleteTarget.name}
          isEmpty={deleteTarget.fileCount === 0}
          onSuccess={() => {
            setDeleteTarget(null)
            refresh()
          }}
        />
      ) : null}
      <BottomTabBar />
    </>
  )
}

function ArchivedProjectRow({ children }: { children: ReactNode }) {
  return (
    <li className="border-divider flex items-center gap-3.5 border-t px-1 py-3.5">
      {children}
    </li>
  )
}
