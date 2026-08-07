import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { IconButton } from '~/components/app/icon-button'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { Textarea } from '~/components/ui/textarea'
import { useT } from '~/hooks/use-t'
import { MAX_COMMENT_BODY_LENGTH } from '~/lib/comments'
import { formatRelative } from '~/lib/datetime'
import { cn } from '~/lib/utils'
import { getOwnerInitial } from '~/lib/user'
import type { CommentThreadView } from '~/lib/comments'
import { IconDots, IconPencil, IconTrash } from '@tabler/icons-react'

export function CommentMessageItem({
  message,
  locale,
  pending,
  className,
  onUpdate,
  onDelete,
}: {
  message: CommentThreadView['messages'][number]
  locale: Parameters<typeof formatRelative>[1]
  pending: boolean
  className?: string
  onUpdate: (messageId: string, body: string) => Promise<boolean>
  onDelete: (messageId: string) => Promise<boolean>
}) {
  const { t } = useT()
  const [editDraft, setEditDraft] = useState<string | null>(null)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const editRef = useRef<HTMLTextAreaElement | null>(null)
  const focusEditAfterMenuRef = useRef(false)

  useEffect(() => {
    if (editDraft === null) return
    const timeoutId = window.setTimeout(() => {
      const editElement = editRef.current
      if (!editElement) return
      editElement.focus({ preventScroll: true })
      editElement.setSelectionRange(
        editElement.value.length,
        editElement.value.length,
      )
    }, 0)
    return () => window.clearTimeout(timeoutId)
  }, [editDraft])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editDraft?.trim()) return
    if (await onUpdate(message.id, editDraft)) setEditDraft(null)
  }

  const confirmDelete = async () => {
    if (await onDelete(message.id)) setDeleteConfirmOpen(false)
  }

  return (
    <div className={cn('relative grid gap-1.5 p-0', className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="text-muted-foreground gap-comment-gap flex min-w-0 items-center text-xs">
          <CommentAvatar
            id={message.author.id}
            image={message.author.image}
            label={message.author.name ?? message.author.email}
          />
          <strong className="text-foreground overflow-hidden font-semibold text-ellipsis whitespace-nowrap">
            {message.author.name ?? message.author.email}
          </strong>
          {message.agent ? (
            <span className="max-w-badge-max px-comment-badge-inline bg-agent-soft text-faint inline-flex items-center overflow-hidden rounded-[var(--r-sm)] py-px text-[length:var(--text-size-2xs)] leading-[var(--lh-badge)] font-medium text-ellipsis whitespace-nowrap">
              {message.agent}
            </span>
          ) : null}
          <span>{formatRelative(message.createdAt, locale)}</span>
          {message.updatedAt !== message.createdAt ? (
            <span>{t('comments.edited')}</span>
          ) : null}
        </div>
        <div className="min-h-control-sm inline-flex items-center">
          {message.canEdit || message.canDelete ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <IconButton
                  type="button"
                  icon={IconDots}
                  size="md"
                  aria-label={t('comments.messageActions')}
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-dropdown-min"
                onCloseAutoFocus={(event: Event) => {
                  if (!focusEditAfterMenuRef.current) return
                  focusEditAfterMenuRef.current = false
                  event.preventDefault()
                }}
              >
                {message.canEdit ? (
                  <DropdownMenuItem
                    onSelect={() => {
                      focusEditAfterMenuRef.current = true
                      setEditDraft(message.body)
                    }}
                  >
                    <IconPencil aria-hidden="true" />
                    {t('comments.edit')}
                  </DropdownMenuItem>
                ) : null}
                {message.canDelete ? (
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={pending}
                    onSelect={() => setDeleteConfirmOpen(true)}
                  >
                    <IconTrash aria-hidden="true" />
                    {t('comments.delete')}
                  </DropdownMenuItem>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
          {message.canDelete ? (
            <AlertDialog
              open={deleteConfirmOpen}
              onOpenChange={setDeleteConfirmOpen}
            >
              <AlertDialogContent size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {t('comments.deleteConfirmTitle')}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('comments.deleteConfirmBody')}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={pending}>
                    {t('confirm.cancel')}
                  </AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    disabled={pending}
                    onClick={(event: MouseEvent<HTMLButtonElement>) => {
                      event.preventDefault()
                      void confirmDelete()
                    }}
                  >
                    {t('comments.deleteConfirmAction')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : null}
        </div>
      </div>
      {editDraft !== null ? (
        <form className="grid gap-2" onSubmit={submit}>
          <Textarea
            ref={editRef}
            className="text-foreground min-h-comment-textarea border-divider bg-card w-full resize-y rounded-[var(--r-lg)] p-2.5 text-sm"
            value={editDraft}
            maxLength={MAX_COMMENT_BODY_LENGTH}
            aria-label={t('comments.editLabel')}
            onChange={(event) => setEditDraft(event.currentTarget.value)}
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditDraft(null)}
            >
              {t('comments.cancelEdit')}
            </Button>
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={!editDraft.trim() || pending}
            >
              {t('comments.saveEdit')}
            </Button>
          </div>
        </form>
      ) : (
        <p className="text-foreground m-0 text-sm leading-(--lh-loose) [overflow-wrap:anywhere] whitespace-pre-wrap">
          {message.body}
        </p>
      )}
    </div>
  )
}

function CommentAvatar({
  id,
  image,
  label,
}: {
  id: string
  image: string | null
  label: string
}) {
  return (
    <span
      className="inline-flex size-5.5 shrink-0 items-center justify-center rounded-full"
      aria-hidden="true"
    >
      <AuthorAvatar
        id={id}
        image={image}
        initial={getOwnerInitial(label, id)}
        className="size-5.5 font-bold"
      />
    </span>
  )
}
