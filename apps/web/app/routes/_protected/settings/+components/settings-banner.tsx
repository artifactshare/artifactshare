import type { ComponentProps } from 'react'
import { Alert } from '~/components/ui/alert'
import { cn } from '~/lib/utils'

export function SettingsBanner({
  className,
  ...props
}: ComponentProps<typeof Alert>) {
  return (
    <Alert
      className={cn(
        'bg-muted text-foreground border-divider mb-[var(--spacing-4)] rounded-[var(--r-md)] px-[var(--spacing-4)] py-[var(--spacing-3)]',
        className,
      )}
      {...props}
    />
  )
}
