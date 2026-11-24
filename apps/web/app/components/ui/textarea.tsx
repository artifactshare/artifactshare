import * as React from 'react'

import { cn } from '~/lib/utils'

function Textarea({
  className,
  ref,
  ...props
}: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      className={cn(
        'border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 disabled:bg-border/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:bg-border/30 dark:disabled:bg-border/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 flex field-sizing-content min-h-16 w-full rounded-lg border bg-transparent px-2.5 py-2 text-base transition-colors outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 disabled:[--input:var(--border)] aria-invalid:ring-3 md:text-sm',
        className,
      )}
      {...props}
    />
  )
}

export { Textarea }
