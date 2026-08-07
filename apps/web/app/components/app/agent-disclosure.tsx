import type { ReactNode } from 'react'
import { Inline } from '~/components/layout/inline'
import { guideFocusRingClassName } from '~/components/app/guide-styles'
import { cn } from '~/lib/utils'
import { IconChevronDown } from '@tabler/icons-react'

// 開閉トグルは shadcn Button にしない。Button base の
// [&_svg:not([class*='size-'])]:size-4 がシェブロン (14px) を 16px に
// 上書きするため、素の button + 同居スタイルの方が副作用が少ない。
const agentDisclosureSummarySurfaceClassName = cn(
  'mx-auto w-fit cursor-pointer rounded-[var(--r-sm)] border-0 bg-transparent px-[var(--spacing-2)] py-[var(--spacing-1)]',
  'text-muted-foreground [font:inherit]',
  'hover:text-foreground hover:bg-accent',
  guideFocusRingClassName,
  '[&_svg]:transition-transform [&_svg]:duration-[var(--duration-base)] [&_svg]:ease-[var(--ease-out)] motion-reduce:[&_svg]:transition-none',
  'group-data-[open=true]/details:[&_svg]:rotate-180',
)

const agentDisclosurePanelInnerClassName = 'min-h-0 overflow-hidden'

const detailsBaseClassName =
  'group/details text-muted-foreground w-full text-left text-xs'

const detailsClassNameByVariant = {
  landing: cn(
    detailsBaseClassName,
    'max-w-agent-disclosure-max mt-[var(--spacing-8)]',
  ),
  preauth: cn(detailsBaseClassName, 'mt-[var(--spacing-2)]'),
}

const panelBaseClassName = cn(
  'grid -translate-y-0.5 grid-rows-[0fr] opacity-0',
  'transition-[grid-template-rows,opacity,translate] ease-[var(--ease-out)] motion-reduce:transition-none',
  'group-data-[open=true]/details:translate-y-0 group-data-[open=true]/details:grid-rows-[1fr] group-data-[open=true]/details:opacity-100',
)

const panelClassNameByVariant = {
  landing: cn(panelBaseClassName, 'duration-[var(--duration-slow)]'),
  preauth: cn(panelBaseClassName, 'duration-[var(--duration-base)]'),
}

export function AgentDisclosure({
  variant = 'preauth',
  open,
  onToggle,
  summaryLabel,
  panelId,
  panelAriaHidden,
  children,
  className,
}: {
  variant?: 'landing' | 'preauth'
  open: boolean
  onToggle: () => void
  summaryLabel: ReactNode
  panelId: string
  panelAriaHidden?: boolean
  children: ReactNode
  className?: string
}) {
  const detailsClassName = cn(detailsClassNameByVariant[variant], className)
  const panelClassName = panelClassNameByVariant[variant]

  return (
    <div className={detailsClassName} data-open={open ? 'true' : 'false'}>
      <Inline gap="1" align="center" asChild>
        <button
          type="button"
          className={agentDisclosureSummarySurfaceClassName}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span>{summaryLabel}</span>
          <IconChevronDown aria-hidden="true" size={14} strokeWidth={2.1} />
        </button>
      </Inline>
      <div
        className={panelClassName}
        id={panelId}
        aria-hidden={panelAriaHidden}
      >
        <div className={agentDisclosurePanelInnerClassName}>{children}</div>
      </div>
    </div>
  )
}
