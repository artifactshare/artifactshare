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
        'border-foreground data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground focus-visible:ring-ring disabled:data-[state=checked]:bg-muted disabled:data-[state=checked]:text-foreground size-4 shrink-0 rounded border focus-visible:ring-2 disabled:cursor-not-allowed disabled:border-dashed',
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
