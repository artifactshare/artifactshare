import type { ReactNode } from 'react'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { useT } from '~/hooks/use-t'

export function HomeListBreadcrumb({ title }: { title: ReactNode }) {
  const { t } = useT()
  return (
    <PageBreadcrumb aria-label={t('project.location')}>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink href="/">{t('tb.home')}</BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{title}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </PageBreadcrumb>
  )
}
