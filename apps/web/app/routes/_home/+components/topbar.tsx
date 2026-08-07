import { IconSettings } from '@tabler/icons-react'
import { useT } from '~/hooks/use-t'
import type { UserInfo } from '~/lib/user'
import { AppTopbar, TopbarBrand } from '~/components/app/app-topbar'
import { AvatarMenu } from '~/components/app/avatar-menu'
import { SearchPalette } from '~/components/app/search-palette'
import { NavigationLink } from '~/components/app/navigation-link'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip'
import { ProjectsDropdown } from './projects-dropdown'
import { primaryNavItems, type JoinedProjectNav } from './primary-nav'

interface TopbarProps {
  workspaceName: string
  user: UserInfo
  joinedProjects?: JoinedProjectNav[]
}

export function Topbar({ workspaceName, user, joinedProjects }: TopbarProps) {
  const { t } = useT()
  const settingsLabel = t('team.settings')

  return (
    <AppTopbar>
      <TopbarBrand workspaceName={workspaceName} title={t('tb.home')} />
      <nav
        className="max-nav:gap-0 inline-flex min-w-0 items-center gap-1"
        aria-label={t('tb.homeView')}
      >
        {primaryNavItems.map(([to, key]) =>
          to === '/projects' && joinedProjects?.length ? (
            <ProjectsDropdown key={to} joinedProjects={joinedProjects} />
          ) : (
            <NavigationLink
              key={to}
              variant="topbar"
              to={to}
              end={to === '/'}
              label={t(key)}
              aria-label={t(key)}
              className="max-nav:hidden"
            />
          ),
        )}
      </nav>
      <div className="flex-1" />
      <SearchPalette />
      <Tooltip>
        <TooltipTrigger asChild>
          <NavigationLink
            variant="topbar"
            to="/settings/general"
            icon={IconSettings}
            label={settingsLabel}
            aria-label={settingsLabel}
          />
        </TooltipTrigger>
        <TooltipContent>{settingsLabel}</TooltipContent>
      </Tooltip>
      <AvatarMenu user={user} />
    </AppTopbar>
  )
}
