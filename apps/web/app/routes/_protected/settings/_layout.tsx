import { logErrorDiagnostic } from '~/lib/error-diagnostics.server'
import { Link, useLocation } from 'react-router'
import type { Route } from './+types/_layout'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { loadSettingsShell } from '~/services/team-management.server'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import { Topbar } from '../../_home/+components/topbar'
import { BottomTabBar } from '../../_home/+components/bottom-tab-bar'
import { listJoinedProjectsForDropdown } from '~/services/project-membership.server'
import type { JoinedProjectNav } from '../../_home/+components/primary-nav'
import { SettingsOutlet } from './+components/settings-outlet'
import { SettingsNav } from './+components/settings-nav'
import { PageHeader } from '~/components/form/page-header'
import { Stack } from '~/components/layout/stack'
import { SettingsPage } from '~/components/form/settings-page'
import { useT } from '~/hooks/use-t'
import type { SettingsShellData } from '~/lib/team-management'
import { toUserInfo, type UserInfo } from '~/lib/user'
import { settingsMainClassName } from '~/components/app/page-shell-styles'

export type SettingsLoaderData = SettingsShellData & {
  user: UserInfo
  joinedProjects: JoinedProjectNav[]
}

export type SettingsLayoutContext = SettingsLoaderData & {
  externalResult?: string | null
}

export async function loader({
  context,
}: Route.LoaderArgs): Promise<SettingsLoaderData> {
  const user = requireUser(context)
  const db = createDb()
  const [settingsShell, joinedProjects] = await Promise.all([
    loadSettingsShell(db, user),
    listJoinedProjectsForDropdown(db, user, 5)
      .then((rows) =>
        rows.map((row) => ({
          id: row.id,
          name: row.name,
          newCount: row.newCount,
          workspaceName: row.workspaceName,
        })),
      )
      .catch((error) => {
        logErrorDiagnostic('settings.projects', error)
        return []
      }),
  ])
  return {
    ...settingsShell,
    user: toUserInfo(user),
    joinedProjects,
  }
}

export default function SettingsLayout({
  loaderData,
}: Pick<Route.ComponentProps, 'loaderData'>) {
  const { pathname } = useLocation()
  const { t } = useT()

  return (
    <>
      <Topbar
        workspaceName={loaderData.workspace.name}
        user={loaderData.user}
        joinedProjects={loaderData.joinedProjects}
      />
      <main className={settingsMainClassName}>
        <SettingsPage>
          <div>
            <PageBreadcrumb aria-label={t('project.location')}>
              <BreadcrumbList>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link to="/">{loaderData.workspace.name}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{t('team.settings')}</BreadcrumbPage>
                </BreadcrumbItem>
              </BreadcrumbList>
            </PageBreadcrumb>
            <PageHeader title={t('team.title')} />
          </div>

          <SettingsNav
            currentUserIsAdmin={loaderData.currentUserIsAdmin}
            workspaceKind={loaderData.kind}
          >
            <Stack gap="4">
              <SettingsOutlet key={pathname} shell={loaderData} />
            </Stack>
          </SettingsNav>
        </SettingsPage>
      </main>
      <BottomTabBar />
    </>
  )
}
