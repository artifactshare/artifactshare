import * as React from 'react'
import { Slot } from 'radix-ui'

import { cn } from '~/lib/utils'

import {
  stackLayoutVariants,
  type LayoutAlign,
  type LayoutGap,
  type LayoutJustify,
} from './layout-shared'

type StackProps = {
  gap: LayoutGap
  align?: LayoutAlign
  justify?: LayoutJustify
  wrap?: boolean
} & (
  | ({ asChild?: false } & React.ComponentProps<'div'>)
  | ({ asChild: true } & React.ComponentProps<typeof Slot.Root>)
)

function Stack(props: StackProps) {
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
        data-slot="stack"
        className={cn(
          stackLayoutVariants({ gap, align, justify, wrap }),
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
      data-slot="stack"
      className={cn(
        stackLayoutVariants({ gap, align, justify, wrap }),
        className,
      )}
      {...divProps}
    />
  )
}

export { Stack, type StackProps }
