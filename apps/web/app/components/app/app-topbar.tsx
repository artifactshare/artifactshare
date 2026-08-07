import { Link } from 'react-router'
import type { ComponentProps, ReactNode } from 'react'

import { BrandMark } from '~/components/app/brand-mark'
import { cn } from '~/lib/utils'

export function AppTopbar({
  className,
  children,
  ...props
}: {
  className?: string
  children: ReactNode
} & Pick<ComponentProps<'header'>, 'id' | 'aria-labelledby'>) {
  return (
    <header
      className={cn(
        'bg-background border-divider sticky top-0 z-[var(--z-topbar)] flex h-12 items-center gap-1.5 border-b px-3',
        'max-nav:gap-1 max-nav:px-2',
        className,
      )}
      {...props}
    >
      {children}
    </header>
  )
}

export function TopbarBrand({
  workspaceName,
  title,
}: {
  workspaceName: string
  title: string
}) {
  return (
    <Link
      to="/"
      className="text-muted-foreground hover:bg-accent hover:text-foreground max-nav:gap-1 max-nav:px-1 max-nav:py-0 flex min-w-0 cursor-pointer items-center gap-2 rounded-[var(--r-sm)] border-0 bg-transparent px-1.5 py-1 text-sm no-underline"
      title={title}
    >
      <BrandMark size={16} aria-hidden="true" />
      <span className="text-foreground max-nav:hidden shrink-0 font-semibold whitespace-nowrap">
        Artifact Share
      </span>
      <span className="max-nav:hidden text-faint" aria-hidden="true">
        ·
      </span>
      <span className="text-muted-foreground max-nav:text-foreground max-nav:font-medium min-w-0 truncate">
        {workspaceName}
      </span>
    </Link>
  )
}
