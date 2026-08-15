import {
  IconActivity,
  IconBoxMultiple as Boxes,
  IconChartBar as BarChart3,
  IconCreditCard as CreditCard,
  IconKey as KeyRound,
  IconPlug as Plug,
  IconRobot,
  IconShare2 as Share2,
  IconSettings as Settings2,
  IconTerminal2,
  IconUsers as Users,
} from '@tabler/icons-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { useLocation } from 'react-router'
import { useT } from '~/hooks/use-t'
import type { TKey } from '~/i18n/messages'
import { TabNav, TabNavLink } from '~/components/app/tab-nav'

const ITEMS: ReadonlyArray<{
  to: string
  end?: boolean
  adminOnly?: boolean
  icon: typeof Users
  label: TKey
}> = [
  { to: '/settings/general', icon: Settings2, label: 'team.general' },
  {
    to: '/settings/external-access',
    icon: Share2,
    label: 'team.externalAccess',
  },
  { to: '/settings', end: true, icon: Users, label: 'team.members' },
  {
    to: '/settings/bots',
    adminOnly: true,
    icon: IconRobot,
    label: 'team.bots',
  },
  { to: '/settings/usage', icon: BarChart3, label: 'team.usage' },
  {
    to: '/settings/tokens',
    icon: KeyRound,
    label: 'team.tokens.api.title',
  },
  {
    to: '/settings/cli-sessions',
    icon: IconTerminal2,
    label: 'team.tokens.cli.title',
  },
  { to: '/settings/integrations', icon: Plug, label: 'team.integrations' },
  { to: '/settings/billing', icon: CreditCard, label: 'team.billing' },
]

export function SettingsNav({
  children,
  currentUserIsAdmin,
  workspaceKind,
}: {
  children: ReactNode
  currentUserIsAdmin: boolean
  workspaceKind: 'upgrade' | 'team'
}) {
  const { t } = useT()
  const location = useLocation()
  const navContainerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    navContainerRef.current
      ?.querySelector<HTMLElement>('[aria-current="page"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [location.pathname])
  return (
    <div className="max-stack:grid-cols-[1fr] max-stack:gap-[var(--spacing-4)] grid grid-cols-[180px_minmax(0,1fr)] items-start gap-[var(--spacing-6)]">
      {/* sticky の top は topbar 高 45px + 余白。TabNav 側は position を持たないためここで所有する。 */}
      <div
        ref={navContainerRef}
        className="max-stack:static max-stack:pb-[var(--spacing-1)] sticky min-w-0"
        style={{ top: 'calc(45px + var(--spacing-4))' }}
      >
        <TabNav aria-label={t('team.nav.label')} orientation="responsive">
          {ITEMS.map(({ to, end, adminOnly, icon: Icon, label }) =>
            adminOnly && !currentUserIsAdmin ? null : (
              <TabNavLink
                key={to}
                to={to}
                end={end}
                icon={Icon}
                label={t(label)}
                orientation="responsive"
              />
            ),
          )}
          {currentUserIsAdmin ? (
            <TabNavLink
              to="/settings/activity"
              icon={IconActivity}
              label={t('team.activity')}
              orientation="responsive"
            />
          ) : null}
          {currentUserIsAdmin && workspaceKind === 'team' ? (
            <TabNavLink
              to="/settings/inventory"
              icon={Boxes}
              label={t('team.inventory')}
              orientation="responsive"
            />
          ) : null}
        </TabNav>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
