import type { ElementType, HTMLAttributes } from 'react'
import { cn } from '~/lib/utils'

export function AppPageHeader({
  className,
  as: Component = 'div',
  ...props
}: HTMLAttributes<HTMLDivElement> & { as?: ElementType }) {
  return (
    <Component
      className={cn(
        'max-stack:flex-col max-stack:items-start mb-4.5 flex items-start justify-between gap-3',
        className,
      )}
      {...props}
    />
  )
}

export function AppPageHeaderMain({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('min-w-0', className)} {...props} />
}

export function AppPageHeaderTitleRow({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}
      {...props}
    />
  )
}

export function AppPageHeaderTitle({
  className,
  ...props
}: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h1
      className={cn(
        'text-foreground m-0 min-w-0 text-xl leading-tight font-semibold [overflow-wrap:anywhere]',
        className,
      )}
      {...props}
    />
  )
}

export function AppPageHeaderDescription({
  className,
  ...props
}: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p
      className={cn('text-muted-foreground mt-1 text-xs', className)}
      {...props}
    />
  )
}

export function AppPageHeaderMeta({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('text-faint mt-1 text-xs font-medium', className)}
      {...props}
    />
  )
}

export function AppPageHeaderActions({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('flex shrink-0 items-center gap-2', className)}
      {...props}
    />
  )
}
