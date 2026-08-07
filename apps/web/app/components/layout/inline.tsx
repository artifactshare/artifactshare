import * as React from 'react'
import { Slot } from 'radix-ui'

import { cn } from '~/lib/utils'

import {
  inlineLayoutVariants,
  type LayoutAlign,
  type LayoutGap,
  type LayoutJustify,
} from './layout-shared'

type InlineProps = {
  gap: LayoutGap
  align?: LayoutAlign
  justify?: LayoutJustify
  wrap?: boolean
} & (
  | ({ asChild?: false } & React.ComponentProps<'div'>)
  | ({ asChild: true } & React.ComponentProps<typeof Slot.Root>)
)

function Inline(props: InlineProps) {
  if (props.asChild) {
    const {
      className,
      gap,
      align,
      justify,
      wrap = false,
      asChild: _asChild,
      ...slotProps
    } = props
    return (
      <Slot.Root
        data-slot="inline"
        className={cn(
          inlineLayoutVariants({ gap, align, justify, wrap }),
          className,
        )}
        {...slotProps}
      />
    )
  }

  const {
    className,
    gap,
    align,
    justify,
    wrap = false,
    asChild: _asChild,
    ...divProps
  } = props
  return (
    <div
      data-slot="inline"
      className={cn(
        inlineLayoutVariants({ gap, align, justify, wrap }),
        className,
      )}
      {...divProps}
    />
  )
}

export { Inline, type InlineProps }
