import type { ElementType, ReactNode } from 'react'
import { cn } from '~/lib/utils'

export function AppSectionHeader({
  title,
  count,
  meta,
  actions,
  className,
  as: Component = 'h2',
  titleId,
  variant = 'section',
}: {
  title: ReactNode
  count?: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  className?: string
  as?: ElementType
  titleId?: string
  variant?: 'section' | 'group'
}) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-2',
        variant === 'group' ? 'mt-3 mb-1' : 'mb-2',
        className,
      )}
    >
      <Component
        id={titleId}
        className={cn(
          'inline-flex items-baseline gap-2',
          variant === 'group'
            ? 'text-faint text-xs font-medium'
            : 'text-foreground text-sm font-semibold',
        )}
      >
        {title}
        {count ? (
          <span className="text-faint text-xs font-medium">{count}</span>
        ) : null}
        {meta ? (
          <span className="text-faint text-xs font-medium">{meta}</span>
        ) : null}
      </Component>
      {actions}
    </div>
  )
}
