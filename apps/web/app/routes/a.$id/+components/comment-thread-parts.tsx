import type { FormEvent, Ref } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { Button } from '~/components/ui/button'
import { IconButton } from '~/components/app/icon-button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { Textarea } from '~/components/ui/textarea'
import { useT } from '~/hooks/use-t'
import { MAX_COMMENT_BODY_LENGTH, quoteCommentText } from '~/lib/comments'
import { cn } from '~/lib/utils'
import type { CommentThreadView } from '~/lib/comments'
import { IconDots, IconTrash } from '@tabler/icons-react'

type ThreadStatus = CommentThreadView['status']

export function CommentStatusBadge({ status }: { status: ThreadStatus }) {
  const { t } = useT()
  return (
    <span
      className={cn(
        'h-badge-height inline-flex items-center rounded-full px-2 text-xs font-bold',
        status === 'resolved'
          ? 'text-success bg-[color-mix(in_srgb,var(--success)_11%,var(--background))]'
          : 'text-link bg-[color-mix(in_srgb,var(--link)_10%,var(--background))]',
      )}
    >
      {t(
        status === 'resolved'
          ? 'comments.statusResolved'
          : 'comments.statusOpen',
      )}
    </span>
  )
}

export function CommentResolveButton({
  status,
  pending,
  disabled,
  variant,
  onResolve,
}: {
  status: ThreadStatus
  pending: boolean
  disabled?: boolean
  variant: 'inline' | 'panel'
  onResolve: () => void
}) {
  const { t } = useT()
  const label = t(
    status === 'resolved' ? 'comments.reopen' : 'comments.resolve',
  )
  if (variant === 'inline') {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="bg-background text-foreground hover:bg-accent hover:text-foreground min-h-touch-target border-divider px-2.5 text-sm"
        disabled={pending || disabled}
        onClick={onResolve}
      >
        {label}
      </Button>
    )
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="bg-background hover:bg-accent hover:text-foreground min-h-touch-target border-divider h-auto px-2.5"
      disabled={pending || disabled}
      onClick={onResolve}
    >
      {label}
    </Button>
  )
}

export function CommentThreadActionsMenu({
  variant,
  canDelete,
  pendingDelete,
  canNavigateToText = false,
  onNavigate,
  onCopyLink,
  onDeleteRequest,
}: {
  variant: 'inline' | 'panel'
  canDelete: boolean
  pendingDelete: boolean
  canNavigateToText?: boolean
  onNavigate?: () => void
  onCopyLink: () => void
  onDeleteRequest: () => void
}) {
  const { t } = useT()
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          type="button"
          icon={IconDots}
          size="md"
          aria-label={t('comments.moreActions')}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-dropdown-min">
        {canNavigateToText && onNavigate ? (
          <DropdownMenuItem onSelect={onNavigate}>
            {t('comments.goToText')}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem onSelect={onCopyLink}>
          {t('comments.copyLink')}
        </DropdownMenuItem>
        {canDelete ? (
          <DropdownMenuItem
            variant="destructive"
            disabled={pendingDelete}
            onSelect={onDeleteRequest}
          >
            <IconTrash aria-hidden="true" />
            {t('comments.delete')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function CommentThreadDeleteDialog({
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  const { t } = useT()
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t('comments.deleteThreadConfirmTitle')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t('comments.deleteThreadConfirmBody')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>
            {t('confirm.cancel')}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={pending}
            onClick={(event) => {
              event.preventDefault()
              onConfirm()
            }}
          >
            {t('comments.deleteConfirmAction')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export function CommentQuote({ text }: { text: string }) {
  return (
    <blockquote className="py-comment-block text-link m-0 rounded-[var(--r-lg)] border border-[color-mix(in_srgb,var(--link)_34%,var(--divider))] bg-transparent px-2.5 text-xs [overflow-wrap:anywhere]">
      {quoteCommentText(text)}
    </blockquote>
  )
}

export function CommentReplyComposer({
  variant,
  value,
  pending,
  inputRef,
  onChange,
  onSubmit,
  onCancel,
}: {
  variant: 'inline' | 'panel'
  value: string
  pending: boolean
  inputRef?: Ref<HTMLTextAreaElement>
  onChange: (value: string) => void
  onSubmit: () => void
  onCancel?: () => void
}) {
  const { t } = useT()
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!value.trim()) return
    onSubmit()
  }
  return (
    <form
      className={
        variant === 'inline'
          ? 'bg-background grid gap-2 px-3 py-2.5 pb-3'
          : 'bg-background border-border mt-0.5 -mr-3 -mb-1 -ml-3 border-t px-3 pt-2.5 pb-1'
      }
      onSubmit={submit}
    >
      {variant === 'inline' ? (
        <textarea
          ref={inputRef}
          className="text-foreground min-h-comment-textarea border-divider bg-card w-full resize-y rounded-[var(--r-lg)] border p-2.5 text-sm"
          value={value}
          maxLength={MAX_COMMENT_BODY_LENGTH}
          aria-label={t('comments.replyLabel')}
          placeholder={t('comments.replyPlaceholder')}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      ) : (
        <Textarea
          ref={inputRef}
          className="text-foreground min-h-comment-textarea border-divider bg-card w-full resize-y rounded-[var(--r-lg)] p-2.5 text-sm"
          value={value}
          maxLength={MAX_COMMENT_BODY_LENGTH}
          aria-label={t('comments.replyLabel')}
          placeholder={t('comments.replyPlaceholder')}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      )}
      <div
        className={
          variant === 'inline'
            ? 'flex justify-end'
            : 'mt-2 flex justify-end gap-2'
        }
      >
        {variant === 'panel' && onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t('confirm.cancel')}
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="default"
          size="sm"
          disabled={!value.trim() || pending}
        >
          {t('comments.reply')}
        </Button>
      </div>
    </form>
  )
}
