import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '~/components/ui/button'
import { IconButton } from '~/components/app/icon-button'
import { copyShareUrl } from '~/lib/clipboard'
import { commentDeepLinkUrl, type CommentThreadView } from '~/lib/comments'
import { type TextSelectionMessage } from '~/lib/csp-reporter'
import { useT } from '~/hooks/use-t'
import { CommentMessageItem } from './comment-message-item'
import {
  CommentQuote,
  CommentReplyComposer,
  CommentResolveButton,
  CommentStatusBadge,
  CommentThreadActionsMenu,
  CommentThreadDeleteDialog,
} from './comment-thread-parts'
import { useCommentMutations } from './use-comment-mutations'
import {
  useInlinePopoverOutsideDismiss,
  useInlinePopoverPosition,
} from './inline-comment-popover-utils'
import { IconX } from '@tabler/icons-react'

export function InlineCommentPopover({
  shareableId,
  thread,
  rect,
  isCurrentShareableId,
  onThreadsChange,
  onClose,
  onOpenConversation,
}: {
  shareableId: string
  thread: CommentThreadView | null
  rect: TextSelectionMessage['rect'] | null
  isCurrentShareableId: (shareableId: string) => boolean
  onThreadsChange: (threads: ReadonlyArray<CommentThreadView>) => void
  onClose: () => void
  onOpenConversation: (threadId: string) => void
}) {
  const translator = useT()
  const { t, tPlural, locale } = translator
  const [replyBody, setReplyBody] = useState('')
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const popoverRef = useRef<HTMLElement | null>(null)
  const commentListRef = useRef<HTMLDivElement | null>(null)
  const replyRef = useRef<HTMLTextAreaElement | null>(null)
  const { mutate, pendingKeys } = useCommentMutations({
    shareableId,
    isCurrentShareableId,
    onThreadsChange,
  })

  useEffect(() => {
    replyRef.current?.focus({ preventScroll: true })
  }, [])
  useInlinePopoverOutsideDismiss(popoverRef, Boolean(thread && rect), onClose)
  const popoverPosition = useInlinePopoverPosition(
    popoverRef,
    rect,
    380,
    Boolean(thread && rect),
  )
  const threadId = thread?.id ?? null
  const threadMessageCount = thread?.messages.length ?? 0

  useLayoutEffect(() => {
    if (!threadId) return
    const commentList = commentListRef.current
    if (!commentList) return
    commentList.scrollTop = commentList.scrollHeight
  }, [threadId, threadMessageCount])

  if (!thread || !rect) return null
  const firstMessage = thread.messages[0]
  const replyMessages = thread.messages.slice(1)
  const visibleReplyMessages = replyMessages.slice(-3)
  const hiddenReplyCount = replyMessages.length - visibleReplyMessages.length
  const pendingResolve = pendingKeys.has(`resolve:${thread.id}`)
  const pendingDelete = pendingKeys.has(`thread:${thread.id}`)
  const hasPendingMutation = pendingKeys.size > 0

  const resolve = async () => {
    await mutate(
      {
        intent: thread.status === 'resolved' ? 'reopen' : 'resolve',
        threadId: thread.id,
      },
      `resolve:${thread.id}`,
    )
  }

  const reply = async () => {
    if (!replyBody.trim()) return
    const ok = await mutate(
      { intent: 'reply', threadId: thread.id, body: replyBody },
      `reply:${thread.id}`,
    )
    if (ok) setReplyBody('')
  }

  const updateMessage = async (messageId: string, body: string) => {
    const ok = await mutate(
      { intent: 'update-message', messageId, body },
      `message:${messageId}`,
    )
    return ok
  }

  const deleteMessage = async (messageId: string) => {
    const ok = await mutate(
      { intent: 'delete-message', messageId },
      `message:${messageId}`,
    )
    if (ok && thread.messages.length <= 1) onClose()
    return ok
  }

  const deleteThread = async () => {
    const ok = await mutate(
      { intent: 'delete-thread', threadId: thread.id },
      `thread:${thread.id}`,
    )
    if (ok) {
      setDeleteConfirmOpen(false)
      onClose()
    }
  }

  return (
    <aside
      ref={popoverRef}
      className="bg-background before:bg-background border-border before:border-border fixed z-(--z-modal) grid w-[var(--width-inline-comment-popover)] gap-0 rounded-[var(--r-lg)] border p-0 shadow-[var(--shadow-pop)] before:absolute before:top-[var(--as-popover-arrow-top,-7px)] before:bottom-[var(--as-popover-arrow-bottom,auto)] before:left-[var(--as-popover-arrow-left,42px)] before:size-3 before:[transform:var(--as-popover-arrow-transform,var(--popover-arrow-transform))] before:border-t before:border-l"
      style={popoverPosition}
      role="region"
      aria-label={t('comments.inlineConversation')}
      onKeyDownCapture={(event) => {
        if (event.key === 'Escape') onClose()
      }}
    >
      <div className="border-divider relative grid gap-2.5 border-b p-3">
        <div className="flex items-center justify-between gap-2.5">
          <CommentStatusBadge status={thread.status} />
          <div className="inline-flex items-center gap-1">
            {thread.canResolve ? (
              <CommentResolveButton
                status={thread.status}
                pending={pendingResolve}
                disabled={hasPendingMutation && !pendingResolve}
                variant="inline"
                onResolve={() => void resolve()}
              />
            ) : null}
            <CommentThreadActionsMenu
              variant="inline"
              canDelete={thread.canResolve}
              pendingDelete={pendingDelete}
              onCopyLink={() =>
                copyShareUrl(
                  commentDeepLinkUrl(window.location.href, thread.id),
                  translator,
                )
              }
              onDeleteRequest={() => setDeleteConfirmOpen(true)}
            />
            {thread.canResolve ? (
              <CommentThreadDeleteDialog
                open={deleteConfirmOpen}
                pending={pendingDelete}
                onOpenChange={setDeleteConfirmOpen}
                onConfirm={() => void deleteThread()}
              />
            ) : null}
            <IconButton
              type="button"
              icon={IconX}
              size="md"
              aria-label={t('common.close')}
              onClick={onClose}
            />
          </div>
        </div>
        {thread.subject.kind === 'text' ? (
          <CommentQuote text={thread.subject.quotedText} />
        ) : null}
        <div
          ref={commentListRef}
          className="max-h-popover-thread-max grid gap-2.5 overflow-y-auto overscroll-contain pr-0.5"
        >
          {firstMessage ? (
            <CommentMessageItem
              message={firstMessage}
              locale={locale}
              className="pt-0"
              pending={pendingKeys.has(`message:${firstMessage.id}`)}
              onUpdate={updateMessage}
              onDelete={deleteMessage}
            />
          ) : null}
          {hiddenReplyCount > 0 ? (
            <button
              type="button"
              className="text-link justify-self-start border-0 bg-transparent p-0 text-xs font-bold hover:underline"
              onClick={() => onOpenConversation(thread.id)}
            >
              {tPlural('comments.previousReplyCount', hiddenReplyCount)}
            </button>
          ) : null}
          {visibleReplyMessages.length > 0 ? (
            <div className="before:top-timeline-top-sm before:left-timeline-offset relative grid gap-2.5 pl-5 before:absolute before:bottom-0.5 before:w-0.5 before:rounded-full before:bg-[color-mix(in_srgb,var(--link)_22%,var(--divider))]">
              {visibleReplyMessages.map((message) => (
                <CommentMessageItem
                  key={message.id}
                  message={message}
                  locale={locale}
                  className="pt-0"
                  pending={pendingKeys.has(`message:${message.id}`)}
                  onUpdate={updateMessage}
                  onDelete={deleteMessage}
                />
              ))}
            </div>
          ) : null}
        </div>
      </div>
      {thread.status === 'open' ? (
        <CommentReplyComposer
          variant="inline"
          value={replyBody}
          pending={hasPendingMutation}
          inputRef={replyRef}
          onChange={setReplyBody}
          onSubmit={() => void reply()}
        />
      ) : null}
    </aside>
  )
}
