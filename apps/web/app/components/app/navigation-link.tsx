import type { TablerIcon } from '@tabler/icons-react'
import type { ComponentPropsWithRef } from 'react'
import { NavLink } from 'react-router'

import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'

export const topbarClassName =
  'inline-flex h-7 shrink-0 items-center gap-1.5 rounded-[var(--r-sm)] px-2 text-sm text-muted-foreground no-underline hover:bg-accent hover:text-foreground aria-[current=page]:bg-accent aria-[current=page]:font-medium aria-[current=page]:text-foreground max-nav:w-8 max-nav:justify-center max-nav:gap-0 max-nav:p-0'

const settingsDisabledClassName =
  'flex items-center gap-[var(--spacing-2)] min-h-8 px-[var(--spacing-3)] rounded-[var(--r-sm)] text-sm text-muted-foreground no-underline hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none max-stack:flex-none hover:text-muted-foreground cursor-not-allowed opacity-50 hover:bg-transparent'

interface NavigationLinkProps extends Omit<
  ComponentPropsWithRef<typeof NavLink>,
  'children' | 'className' | 'to'
> {
  variant: 'topbar'
  to: string
  end?: boolean
  /** 省略時はテキストのみの PC 一級ナビ。 */
  icon?: TablerIcon
  label: string
  className?: string
  'aria-label'?: string
}

export function NavigationLink({
  variant,
  to,
  end,
  icon: Icon,
  label,
  className,
  'aria-label': ariaLabel,
  ref,
  ...linkProps
}: NavigationLinkProps) {
  const content = (
    <>
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      <span className="max-nav:hidden">{label}</span>
    </>
  )

  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn(topbarClassName, className)}
      asChild
    >
      <NavLink
        {...linkProps}
        ref={ref}
        to={to}
        end={end}
        aria-label={ariaLabel}
      >
        {content}
      </NavLink>
    </Button>
  )
}

export function NavigationLinkDisabled({
  icon: Icon,
  label,
  note,
}: {
  icon: TablerIcon
  label: string
  note?: string
}) {
  return (
    <span aria-disabled="true" className={settingsDisabledClassName}>
      <Icon size={16} aria-hidden="true" />
      {label}
      {note ? <span className="text-xs">{note}</span> : null}
    </span>
  )
}
