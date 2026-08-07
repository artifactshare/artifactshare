import type { ComponentProps } from 'react'
import { Breadcrumb } from '~/components/ui/breadcrumb'
import { cn } from '~/lib/utils'

/** List-page breadcrumb that owns the rhythm to the page heading below. */
export function PageBreadcrumb({
  className,
  ...props
}: ComponentProps<typeof Breadcrumb>) {
  return <Breadcrumb className={cn('mb-2', className)} {...props} />
}
