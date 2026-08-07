import type { ComponentProps } from 'react'

export function SegmentedControlGroup({
  className,
  ...props
}: ComponentProps<'div'>) {
  // A segmented control joins mutually exclusive choices into one control.
  return (
    <div
      data-slot="segmented-control-group"
      data-gap-audit-composite
      className={className}
      {...props}
    />
  )
}
