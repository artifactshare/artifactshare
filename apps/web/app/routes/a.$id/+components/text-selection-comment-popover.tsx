import { useEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { IconButton } from '~/components/app/icon-button'
import { MAX_COMMENT_BODY_LENGTH, type CommentThreadView } from '~/lib/comments'
import { useT } from '~/hooks/use-t'
import { CommentQuote } from './comment-thread-parts'
import { useCommentMutations } from './use-comment-mutations'
import { type PendingTextAnchor } from './viewer-comment-types'
import {
  useInlinePopoverOutsideDismiss,
  useInlinePopoverPosition,
  withoutRect,
} from './inline-comment-popover-utils'
import { IconMessage, IconX } from '@tabler/icons-react'

export function TextSelectionCommentPopover({
  shareableId,
  anchor,
  isCurrentShareableId,
  onThreadsChange,
  onClose,
}: {
  shareableId: string
  anchor: PendingTextAnchor
  isCurrentShareableId: (shareableId: string) => boolean
  onThreadsChange: (threads: ReadonlyArray<CommentThreadView>) => void
  onClose: () => void
}) {
  const { t } = useT()
  const [body, setBody] = useState('')
  const popoverRef = useRef<HTMLElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const { mutate, pendingKeys } = useCommentMutations({
    shareableId,
    isCurrentShareableId,
    onThreadsChange,
  })
  const pending = pendingKeys.has('create-thread')

  useEffect(() => {
    textareaRef.current?.focus({ preventScroll: true })
  }, [])
  useInlinePopoverOutsideDismiss(popoverRef, true, onClose)
  const popoverPosition = useInlinePopoverPosition(
    popoverRef,
    anchor.rect,
    300,
    true,
  )

  const submit = async () => {
    if (!body.trim()) return
    const ok = await mutate(
      { intent: 'create-thread', body, anchor: withoutRect(anchor) },
      'create-thread',
    )
    if (ok) onClose()
  }

  return (
    <aside
      ref={popoverRef}
      className="bg-background before:bg-background border-border before:border-border fixed z-(--z-modal) grid w-[var(--width-text-selection-popover)] gap-0 rounded-[var(--r-lg)] border p-0 shadow-[var(--shadow-pop)] before:absolute before:top-[var(--as-popover-arrow-top,-7px)] before:bottom-[var(--as-popover-arrow-bottom,auto)] before:left-[var(--as-popover-arrow-left,52px)] before:size-3 before:[transform:var(--as-popover-arrow-transform,var(--popover-arrow-transform))] before:border-t before:border-l"
      style={popoverPosition}
      role="region"
      aria-label={t('comments.addInlineTitle')}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="text-muted-foreground border-divider flex min-h-10 items-center justify-between gap-2 border-b px-2.5 py-2 text-xs">
        <span className="text-foreground gap-comment-gap inline-flex min-w-0 items-center font-bold">
          <span
            className="[&_svg]:size-icon-popover bg-link-soft text-link inline-flex size-5 items-center justify-center rounded-full"
            aria-hidden="true"
          >
            <IconMessage />
          </span>
          {t('comments.addInlineTitle')}
        </span>
        <IconButton
          type="button"
          icon={IconX}
          size="md"
          aria-label={t('common.close')}
          onClick={onClose}
        />
      </div>
      <div className="bg-background grid gap-2 px-2.5 pt-2 pb-2.5">
        <CommentQuote text={anchor.quotedText} />
        <textarea
          ref={textareaRef}
          className="text-foreground min-h-comment-textarea-sm border-divider bg-card w-full resize-y rounded-[var(--r-lg)] border p-2.5 text-sm"
          value={body}
          maxLength={MAX_COMMENT_BODY_LENGTH}
          aria-label={t('comments.newLabel')}
          placeholder={t('comments.newTextPlaceholder')}
          onChange={(event) => setBody(event.currentTarget.value)}
        />
        <div className="flex justify-end">
          <Button
            type="button"
            variant="default"
            size="sm"
            disabled={!body.trim() || pending}
            onClick={submit}
          >
            {t('comments.comment')}
          </Button>
        </div>
      </div>
    </aside>
  )
}
