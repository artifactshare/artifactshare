import { useCopyState } from '~/hooks/use-copy-state'
import { useT } from '~/hooks/use-t'
import { Inline } from '~/components/layout/inline'
import { guideFocusRingClassName } from '~/components/app/guide-styles'
import { cn } from '~/lib/utils'
import { IconCheck } from '@tabler/icons-react'

interface CopyLabels {
  copy: string
  copied: string
  failed: string
}

const connectorUrlCopyContainerSurfaceClassName = cn(
  'border-border bg-card m-0 rounded-[var(--r-md)] border py-[var(--spacing-2)] pr-[var(--spacing-2)] pl-[var(--spacing-3)] shadow-[var(--shadow-sm)]',
  'transition-[border-color] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
  'focus-within:border-border-strong hover:border-border-strong',
)

const connectorUrlCopyCodeClassName =
  'min-w-0 grow shrink basis-50 overflow-x-auto border-0 bg-transparent py-[var(--spacing-0_5)] font-mono text-xs break-normal whitespace-nowrap text-foreground'

const connectorUrlCopyButtonClassName = cn(
  'border-border bg-card text-foreground inline-flex cursor-pointer items-center justify-center gap-[var(--spacing-1_5)] rounded-[var(--r-sm)] border text-center text-xs font-medium',
  'px-[var(--spacing-3)] py-[var(--spacing-1_5)] [min-inline-size:var(--spacing-connector-copy-min)]',
  'transition-[border-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
  'hover:border-border-strong hover:shadow-[var(--shadow-sm)]',
  guideFocusRingClassName,
)

/** The connector URL plus a copy button. Used on the `/connect` setup page. */
export function ConnectorUrlCopy({
  url,
  labels,
}: {
  url: string
  labels?: CopyLabels
}) {
  const { t } = useT()
  const { state, copy } = useCopyState(url)

  const label =
    state === 'copied'
      ? (labels?.copied ?? t('lp.connect.copiedButton'))
      : state === 'failed'
        ? (labels?.failed ?? t('lp.connect.copyFailedButton'))
        : (labels?.copy ?? t('lp.connect.copy'))

  return (
    <Inline
      gap="2"
      align="center"
      wrap
      className={connectorUrlCopyContainerSurfaceClassName}
    >
      <code className={connectorUrlCopyCodeClassName}>{url}</code>
      <button
        type="button"
        onClick={copy}
        className={connectorUrlCopyButtonClassName}
      >
        {state === 'copied' && (
          <IconCheck
            className="text-success"
            aria-hidden="true"
            size={14}
            strokeWidth={2.4}
          />
        )}
        <span>{label}</span>
      </button>
    </Inline>
  )
}
