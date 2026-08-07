import type { ComponentProps } from 'react'

import { cn } from '~/lib/utils'

const sizeClassName = {
  16: 'size-4',
  20: 'size-5',
  24: 'size-6',
  32: 'size-8',
} as const

export type BrandMarkSize = keyof typeof sizeClassName

interface BrandMarkProps extends Omit<ComponentProps<'span'>, 'children'> {
  size: BrandMarkSize
}

export function BrandMark({ size, className, ...props }: BrandMarkProps) {
  return (
    <span
      className={cn(
        'inline-block shrink-0 rounded-[var(--r-sm)] bg-[url(/favicon.svg)] bg-contain bg-center bg-no-repeat',
        sizeClassName[size],
        className,
      )}
      {...props}
    />
  )
}
