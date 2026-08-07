import type { ComponentProps } from 'react'

import { cn } from '~/lib/utils'

export function TeamMuted({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('text-muted-foreground block truncate text-xs', className)}
      {...props}
    />
  )
}

export function TeamMutedParagraph({
  className,
  ...props
}: ComponentProps<'p'>) {
  return (
    <p className={cn('text-muted-foreground text-sm', className)} {...props} />
  )
}
