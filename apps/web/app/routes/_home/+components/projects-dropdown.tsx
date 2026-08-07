import { IconChevronDown } from '@tabler/icons-react'
import { Link, useLocation } from 'react-router'
import { topbarClassName } from '~/components/app/navigation-link'
import { ProjectMark } from '~/components/app/project-mark'
import { ProjectNewBadge } from '~/components/app/project-new-badge'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { useT } from '~/hooks/use-t'
import type { JoinedProjectNav } from './primary-nav'

export function ProjectsDropdown({
  joinedProjects,
}: {
  joinedProjects: JoinedProjectNav[]
}) {
  const { t } = useT()
  const { pathname } = useLocation()
  const isCurrent =
    pathname === '/projects' || pathname.startsWith('/projects/')
  return (
    <span>
      {/* Hover 開閉は、隣のナビへ移動するだけでメニューが重なるため使わない。 */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={`${topbarClassName} max-nav:hidden aria-expanded:text-muted-foreground hover:aria-expanded:bg-accent hover:aria-expanded:text-foreground cursor-pointer aria-expanded:bg-transparent`}
            aria-label={t('tb.projects')}
            aria-current={isCurrent ? 'page' : undefined}
          >
            {t('tb.projects')}
            <IconChevronDown size={12} aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-64">
          {joinedProjects.map((project) => (
            <DropdownMenuItem key={project.id} asChild>
              <Link
                to={`/projects/${project.id}`}
                className="flex w-full min-w-0 items-center gap-2"
              >
                <ProjectMark id={project.id} name={project.name} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{project.name}</span>
                  {project.workspaceName ? (
                    <span className="text-muted-foreground block truncate text-xs">
                      {project.workspaceName}
                    </span>
                  ) : null}
                </span>
                <ProjectNewBadge count={project.newCount} />
              </Link>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to="/projects" className="text-link">
              {t('home.allProjects')}
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}
