import type { ComponentProps } from 'react'

export function SegmentedControlGroup({
  className,
  ...props
}: ComponentProps<'div'>) {
  return (
    <div
      data-slot="segmented-control-group"
      data-gap-audit-composite
      className={className}
      {...props}
    />
  )
}
