import { Link, Outlet, useSearchParams } from 'react-router'
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
import { SettingsBanner } from './+components/settings-banner'
import { SettingsNav } from './+components/settings-nav'
import { PageHeader } from '~/components/form/page-header'
import { SettingsPage } from '~/components/form/settings-page'
import { useT } from '~/hooks/use-t'
import type { TKey } from '~/i18n/messages'
import type {
  SettingsShellData,
  TeamMutationResult,
} from '~/lib/team-management'
import { toUserInfo, type UserInfo } from '~/lib/user'
import { settingsMainClassName } from '~/components/app/page-shell-styles'

type SettingsLoaderData = SettingsShellData & {
  user: UserInfo
  joinedProjects: JoinedProjectNav[]
}

export type BillingStatusKey =
  | 'checkout-success'
  | 'checkout-cancelled'
  | 'plan-change-requested'
  | 'already-subscribed'
  | 'no-subscription'
  | 'plan-required'
  | 'invalid-policy'

type SettingsStatusKey =
  | TeamMutationResult['kind']
  | BillingStatusKey
  | 'removed'
  | 'removed-transfer-failed'
  | 'restore-unavailable'

export type SettingsLayoutContext = SettingsLoaderData

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
      .catch(() => []),
  ])
  return {
    ...settingsShell,
    user: toUserInfo(user),
    joinedProjects,
  }
}

export default function SettingsLayout({ loaderData }: Route.ComponentProps) {
  const [searchParams] = useSearchParams()
  const status = searchParams.get('status')
  const { t } = useT()

  return (
    <>
      <Topbar
        workspaceName={loaderData.workspace.name}
        user={loaderData.user}
        joinedProjects={loaderData.joinedProjects}
      />
      <main className={settingsMainClassName}>
        {status ? <StatusBanner status={status as SettingsStatusKey} /> : null}
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
            <Outlet context={loaderData} />
          </SettingsNav>
        </SettingsPage>
      </main>
      <BottomTabBar />
    </>
  )
}

function StatusBanner({ status }: { status: SettingsStatusKey }) {
  const message = SETTINGS_STATUS_MESSAGES[status] ?? 'team.status.generic'
  const { t } = useT()
  return <SettingsBanner role="status">{t(message)}</SettingsBanner>
}

const SETTINGS_STATUS_MESSAGES: Record<SettingsStatusKey, TKey> = {
  ok: 'team.status.ok',
  removed: 'team.status.removed',
  'removed-transfer-failed': 'team.status.removedTransferFailed',
  'restore-unavailable': 'team.status.restoreUnavailable',
  forbidden: 'team.status.forbidden',
  'self-forbidden': 'team.status.selfForbidden',
  'not-team': 'team.status.notTeam',
  'not-found': 'team.status.notFound',
  invalid: 'team.status.invalid',
  'external-failed': 'team.status.externalFailed',
  'checkout-success': 'billing.status.checkoutSuccess',
  'checkout-cancelled': 'billing.status.checkoutCancelled',
  'plan-change-requested': 'billing.status.planChangeRequested',
  'already-subscribed': 'billing.status.alreadySubscribed',
  'no-subscription': 'billing.status.noSubscription',
  'plan-required': 'team.status.planRequired',
  'invalid-policy': 'team.status.invalidPolicy',
  'bot-revoke-not-supported': 'team.status.botRevokeNotSupported',
}
