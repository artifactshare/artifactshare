import type { TablerIcon } from '@tabler/icons-react'
import type { ComponentPropsWithRef, ReactNode } from 'react'
import { NavLink } from 'react-router'
import { cn } from '~/lib/utils'

const linkClassName =
  'relative inline-flex items-center gap-[var(--spacing-2)] whitespace-nowrap text-sm text-muted-foreground no-underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring after:absolute after:bg-foreground after:opacity-0 after:transition-opacity aria-[current=page]:font-medium aria-[current=page]:text-foreground aria-[current=page]:after:opacity-100'

// 横 (下線) を基底にし、responsive は stack 以上で縦 (右端インジケータ) に上書きする。
// 双方向の上書きは cascade が読めなくなるため、上書きは stack: の一方向だけにする。
const horizontalNavClassName = 'flex gap-[var(--spacing-4)] overflow-x-auto'
const verticalNavOverrideClassName =
  'stack:flex-col stack:gap-[var(--spacing-1)] stack:overflow-visible'
const horizontalLinkClassName =
  'min-h-9 px-1 after:inset-x-0 after:bottom-0 after:h-0.5'
const verticalLinkOverrideClassName =
  'stack:min-h-8 stack:px-[var(--spacing-3)] stack:after:inset-x-auto stack:after:inset-y-0 stack:after:right-0 stack:after:h-auto stack:after:w-0.5'

export function TabNav({
  'aria-label': ariaLabel,
  orientation = 'horizontal',
  children,
  className,
}: {
  'aria-label': string
  orientation?: 'horizontal' | 'responsive'
  children: ReactNode
  className?: string
}) {
  return (
    <nav
      aria-label={ariaLabel}
      className={cn(
        horizontalNavClassName,
        orientation === 'responsive' && verticalNavOverrideClassName,
        className,
      )}
    >
      {children}
    </nav>
  )
}

export function TabNavLink({
  icon: Icon,
  label,
  orientation = 'horizontal',
  className,
  ref,
  ...props
}: Omit<ComponentPropsWithRef<typeof NavLink>, 'children' | 'className'> & {
  icon?: TablerIcon
  label: string
  orientation?: 'horizontal' | 'responsive'
  className?: string
}) {
  return (
    <NavLink
      {...props}
      ref={ref}
      className={cn(
        linkClassName,
        horizontalLinkClassName,
        orientation === 'responsive' && verticalLinkOverrideClassName,
        className,
      )}
    >
      {Icon ? <Icon size={16} aria-hidden="true" /> : null}
      <span>{label}</span>
    </NavLink>
  )
}
