import type { ComponentProps } from 'react'
import type { TablerIcon } from '@tabler/icons-react'

import { Button } from '~/components/ui/button'
import { cn } from '~/lib/utils'

const sizeClassName = {
  sm: 'size-7 rounded-[var(--r-sm)] hover:border-border',
  md: 'size-7.5 rounded-[var(--r-lg)]',
} as const

const iconSize = {
  sm: 14,
  md: 15,
} as const

const iconStrokeWidth = {
  sm: 2,
  md: 2.2,
} as const

type IconButtonProps = Omit<
  ComponentProps<typeof Button>,
  'children' | 'size' | 'variant'
> & {
  icon: TablerIcon
  size: keyof typeof sizeClassName
}

export function IconButton({
  icon: Icon,
  size,
  className,
  ...props
}: IconButtonProps) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        'text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-auto',
        sizeClassName[size],
        className,
      )}
      {...props}
    >
      <Icon
        className="size-auto"
        size={iconSize[size]}
        strokeWidth={iconStrokeWidth[size]}
        aria-hidden="true"
      />
    </Button>
  )
}
