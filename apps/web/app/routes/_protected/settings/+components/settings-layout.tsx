import { Link, useLocation } from 'react-router'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import { Topbar } from '../../../_home/+components/topbar'
import { BottomTabBar } from '../../../_home/+components/bottom-tab-bar'
import { SettingsOutlet } from './settings-outlet'
import { SettingsNav } from './settings-nav'
import { PageHeader } from '~/components/form/page-header'
import { Stack } from '~/components/layout/stack'
import { SettingsPage } from '~/components/form/settings-page'
import { useT } from '~/hooks/use-t'
import { settingsMainClassName } from '~/components/app/page-shell-styles'
import type { SettingsLoaderData } from '../_layout'

export default function SettingsLayout({
  loaderData,
}: {
  loaderData: SettingsLoaderData
}) {
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
