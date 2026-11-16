import * as React from 'react'
import { Checkbox as CheckboxPrimitive } from 'radix-ui'
import { IconCheck } from '@tabler/icons-react'
import { cn } from '~/lib/utils'

export function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        'border-input data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground focus-visible:ring-ring size-4 shrink-0 rounded border focus-visible:ring-2',
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator>
        <IconCheck className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}
