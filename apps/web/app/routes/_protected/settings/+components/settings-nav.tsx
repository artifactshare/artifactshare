import {
  IconActivity,
  IconBoxMultiple,
  IconChartBar,
  IconCreditCard,
  IconPlug,
  IconTerminal2,
  IconRobot,
  IconShare2,
  IconSettings,
  IconUsers,
  IconChevronDown,
} from '@tabler/icons-react'
import { useState, type ReactNode } from 'react'
import {
  Link,
  matchPath,
  resolvePath,
  useLocation,
  useResolvedPath,
} from 'react-router'
import { useT } from '~/hooks/use-t'
import type { TKey } from '~/i18n/messages'
import {
  settingsAdminPageAccess,
  type SettingsAdminPage,
} from '~/lib/settings-access'
import { Button } from '~/components/ui/button'
import {
  Sheet,
  SheetTrigger,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetClose,
} from '~/components/ui/sheet'

// Each `to` is relative to the Settings shell route that renders the menu.
const GROUPS: {
  label: TKey
  items: {
    to: string
    label: TKey
    icon: typeof IconUsers
    adminPage?: SettingsAdminPage
  }[]
}[] = [
  {
    label: 'settings.group.your',
    items: [
      {
        to: 'tokens',
        label: 'settings.connections',
        icon: IconTerminal2,
      },
      {
        to: 'analytics',
        label: 'settings.analytics',
        icon: IconChartBar,
      },
    ],
  },
  {
    label: 'settings.group.workspace',
    items: [
      { to: '.', label: 'team.members', icon: IconUsers },
      {
        to: 'bots',
        label: 'team.bots',
        icon: IconRobot,
        adminPage: 'bots',
      },
      {
        to: 'external-access',
        label: 'team.externalAccess',
        icon: IconShare2,
      },
      {
        to: 'integrations',
        label: 'team.integrations',
        icon: IconPlug,
      },
    ],
  },
  {
    label: 'settings.group.review',
    items: [
      {
        to: 'activity',
        label: 'team.activity',
        icon: IconActivity,
        adminPage: 'activity',
      },
      {
        to: 'inventory',
        label: 'team.inventory',
        icon: IconBoxMultiple,
        adminPage: 'inventory',
      },
    ],
  },
  {
    label: 'settings.group.plan',
    items: [{ to: 'billing', label: 'team.billing', icon: IconCreditCard }],
  },
  {
    label: 'settings.group.info',
    items: [{ to: 'general', label: 'team.general', icon: IconSettings }],
  },
]

type SettingsNavProps = {
  children: ReactNode
  currentUserIsAdmin: boolean
  workspaceKind: 'upgrade' | 'team'
}
export function SettingsNav(props: SettingsNavProps) {
  const { pathname } = useLocation()
  return <SettingsNavigation {...props} pathname={pathname} />
}
/** The menu groups and items a person in this role may open, in order. */
export function settingsNavGroups({
  currentUserIsAdmin,
  workspaceKind,
}: Pick<SettingsNavProps, 'currentUserIsAdmin' | 'workspaceKind'>) {
  return GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      ({ adminPage }) =>
        !adminPage ||
        settingsAdminPageAccess(adminPage, {
          isAdmin: currentUserIsAdmin,
          team: workspaceKind === 'team',
        }) === 'allowed',
    ),
  })).filter((group) => group.items.length)
}

export function SettingsNavigation({
  pathname,
  children,
  currentUserIsAdmin,
  workspaceKind,
}: SettingsNavProps & { pathname: string }) {
  const { t } = useT()
  const [openPath, setOpenPath] = useState<string | null>(null)
  const shellPath = useResolvedPath('.').pathname
  const groups = settingsNavGroups({ currentUserIsAdmin, workspaceKind }).map(
    (group) => ({
      ...group,
      items: group.items.map((item) => ({
        ...item,
        to: resolvePath(item.to, shellPath).pathname,
      })),
    }),
  )
  const matchesItem = (item: { to: string }) =>
    matchPath({ path: item.to, end: item.to === shellPath }, pathname)
  const currentGroup = groups.find((group) => group.items.some(matchesItem))
  const current = currentGroup?.items.find(matchesItem)
  const menu = (
    <nav aria-label={t('team.nav.label')} className="flex flex-col gap-4">
      {groups.map((group) => (
        <section key={group.label} className="flex flex-col gap-1">
          <h2 className="text-muted-foreground px-3 text-xs font-medium">
            {t(group.label)}
          </h2>
          {group.items.map(({ to, label, icon: Icon }) => (
            <Link
              key={to}
              to={to}
              aria-current={current?.to === to ? 'page' : undefined}
              onClick={() => setOpenPath(null)}
              className="text-muted-foreground hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:text-foreground focus-visible:outline-ring stack:min-h-8 flex min-h-11 items-center gap-2 rounded-md px-3 text-sm no-underline focus-visible:outline-2"
            >
              <Icon size={16} aria-hidden="true" />
              <span>{t(label)}</span>
            </Link>
          ))}
        </section>
      ))}
    </nav>
  )
  return (
    <div className="max-stack:grid-cols-[1fr] max-stack:gap-4 grid grid-cols-[200px_minmax(0,1fr)] items-start gap-6">
      <div className="max-stack:hidden sticky top-16">{menu}</div>
      <div className="stack:hidden">
        <Sheet
          open={openPath === pathname}
          onOpenChange={(open) => setOpenPath(open ? pathname : null)}
        >
          <SheetTrigger asChild>
            <Button
              variant="outline"
              className="min-h-11 w-full justify-between"
            >
              <span>{t(current?.label ?? 'team.settings')}</span>
              {currentGroup ? (
                <span className="text-muted-foreground text-xs">
                  {t(currentGroup.label)}
                </span>
              ) : null}
              <IconChevronDown aria-hidden="true" size={16} />
            </Button>
          </SheetTrigger>
          <SheetContent
            side="bottom"
            aria-describedby={undefined}
            className="max-h-(--height-search-filter-sheet) rounded-t-xl"
          >
            <SheetHeader>
              <SheetTitle>{t('team.settings')}</SheetTitle>
              <SheetClose asChild>
                <Button variant="ghost" size="sm">
                  {t('settings.close')}
                </Button>
              </SheetClose>
            </SheetHeader>
            <div className="overflow-y-auto px-3 pb-6">{menu}</div>
          </SheetContent>
        </Sheet>
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}
