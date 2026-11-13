import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { useT } from '~/hooks/use-t'

export function ProjectPageBreadcrumb({
  title,
  project,
}: {
  title: ReactNode
  project?: { id: string; name: string }
}) {
  const { t } = useT()
  return (
    <PageBreadcrumb aria-label={t('project.location')}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/">{t('tb.home')}</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to="/projects">{t('project.projects')}</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        {project ? (
          <>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to={`/projects/${project.id}`}>{project.name}</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
          </>
        ) : null}
        <BreadcrumbItem>
          <BreadcrumbPage>{title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </PageBreadcrumb>
  )
}
