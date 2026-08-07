import { type ReactNode } from 'react'
import { useCopyState } from '~/hooks/use-copy-state'
import { Button } from '~/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '~/components/ui/tooltip'
import { Inline } from '~/components/layout/inline'
import { guideFocusRingClassName } from '~/components/app/guide-styles'
import { cn } from '~/lib/utils'
import { IconCheck, IconCopy } from '@tabler/icons-react'

export interface CopyableCodeLabels {
  copy: string
  copied: string
  failed: string
}

const copyableCodeHeadSurfaceClassName = cn(
  'border-border bg-card border-b',
  'py-[var(--spacing-1_5)] pr-[var(--spacing-2)] pl-[var(--spacing-3)]',
)

const copyableCodeCopyButtonClassName = cn(
  'text-faint inline-flex min-h-7 cursor-pointer items-center gap-1.5 rounded-[var(--r-sm)] border border-transparent px-2 shadow-none',
  'transition-[color,background] duration-[var(--duration-fast)] ease-[var(--ease-out)] motion-reduce:transition-none',
  'hover:bg-accent hover:text-foreground',
  // Button base の active:not-aria-[haspopup]:translate-y-px と同じ modifier
  // 連鎖で書かないと tailwind-merge が畳まず、詳細度でも負けて 1px 沈む。
  'dark:hover:bg-accent active:not-aria-[haspopup]:translate-y-0',
  'focus-visible:border-transparent focus-visible:ring-0',
  guideFocusRingClassName,
)

const copyableCodePreDefaultClassName =
  'px-[var(--spacing-4)] py-[var(--spacing-3)] text-sm leading-[var(--lh-prose)]'

export function CopyableCodeBlock({
  code,
  name,
  labels,
  children,
  compact = false,
  copyTabIndex,
  className,
  copyButtonVariant,
}: {
  code: string
  name: string
  labels: CopyableCodeLabels
  children?: ReactNode
  compact?: boolean
  copyTabIndex?: number
  className?: string
  copyButtonVariant?: 'default' | 'ghost'
}) {
  const { state, copy } = useCopyState(code)
  const label =
    state === 'copied'
      ? labels.copied
      : state === 'failed'
        ? labels.failed
        : labels.copy

  return (
    <div
      className={cn(
        'border-border bg-muted mt-[var(--spacing-2)] overflow-hidden rounded-[var(--r-md)] border',
        className,
      )}
    >
      <Inline
        gap="0"
        align="center"
        justify="between"
        className={copyableCodeHeadSurfaceClassName}
      >
        <span className="text-muted-foreground font-mono text-xs">{name}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={copyButtonVariant ?? 'ghost'}
              aria-label={label}
              tabIndex={copyTabIndex}
              onClick={copy}
              className={copyableCodeCopyButtonClassName}
            >
              {state === 'copied' ? (
                <IconCheck
                  aria-hidden="true"
                  // size-auto opts out of Button's [&_svg:not([class*='size-'])]:size-4,
                  // letting the SVG's own 15px width/height attributes apply.
                  className="text-success size-auto"
                  size={15}
                  strokeWidth={2.4}
                />
              ) : (
                <IconCopy
                  aria-hidden="true"
                  className="size-auto"
                  size={15}
                  strokeWidth={2.1}
                />
              )}
              <span>{label}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      </Inline>
      {state !== 'idle' ? (
        <span className="sr-only" role="status" aria-live="polite">
          {label}
        </span>
      ) : null}
      {/* Horizontal code scrolling requires focus on the scroll container;
          axe flags a focusable copy button alone as insufficient. */}
      {/* react-doctor-disable-next-line react-doctor/no-noninteractive-tabindex */}
      <pre
        // the filename tab sits flush on the code area by design
        data-gap-audit-allow-touch
        tabIndex={copyTabIndex ?? 0}
        className={cn(
          'text-foreground m-0 overflow-x-auto font-mono',
          compact
            ? 'px-[var(--spacing-3)] py-[var(--spacing-2)] text-xs leading-(--lh-loose)'
            : copyableCodePreDefaultClassName,
        )}
      >
        <code className="whitespace-pre [font:inherit]">
          {children ?? code}
        </code>
      </pre>
    </div>
  )
}
