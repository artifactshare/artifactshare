import { useRef } from 'react'
import { useT } from '~/hooks/use-t'
import { type PendingTextAnchor } from './viewer-comment-types'
import {
  useInlinePopoverOutsideDismiss,
  useInlinePopoverPosition,
} from './inline-comment-popover-utils'
import { IconMessage } from '@tabler/icons-react'

export function TextSelectionCommentChip({
  anchor,
  onStart,
  onDismiss,
}: {
  anchor: PendingTextAnchor
  onStart: () => void
  onDismiss: () => void
}) {
  const { t } = useT()
  const chipRef = useRef<HTMLDivElement | null>(null)
  useInlinePopoverOutsideDismiss(chipRef, true, onDismiss)
  const position = useInlinePopoverPosition(
    chipRef,
    anchor.rect,
    SELECTION_CHIP_WIDTH,
    true,
  )

  return (
    <div ref={chipRef} className="fixed z-(--z-modal)" style={position}>
      <button
        type="button"
        className="bg-background text-foreground hover:bg-muted [&_svg]:size-icon-comment border-border [&_svg]:text-link inline-flex cursor-pointer items-center gap-1.5 rounded-full border py-1.5 pr-3 pl-2.5 text-sm leading-(--lh-tight) font-bold shadow-[var(--shadow-pop)] transition-[background] duration-[var(--duration-fast)]"
        aria-label={t('comments.addInlineTitle')}
        onClick={onStart}
      >
        <IconMessage aria-hidden="true" />
        <span>{t('comments.comment')}</span>
      </button>
    </div>
  )
}

const SELECTION_CHIP_WIDTH = 132
