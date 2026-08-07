import type { ElementType, HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

export function AppDividerList({
  className,
  as: Component = 'div',
  ...props
}: HTMLAttributes<HTMLDivElement> & { as?: ElementType }) {
  return (
    <Component
      className={cn('border-divider flex flex-col gap-1 border-t', className)}
      {...props}
    />
  )
}
