import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useReducer,
  type FormEvent,
  type RefObject,
} from 'react'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Button } from '~/components/ui/button'
import { IconButton } from '~/components/app/icon-button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { Textarea } from '~/components/ui/textarea'
import { useT } from '~/hooks/use-t'
import { copyShareUrl } from '~/lib/clipboard'
import {
  commentDeepLinkUrl,
  MAX_COMMENT_BODY_LENGTH,
  quoteCommentText,
} from '~/lib/comments'
import { formatRelative } from '~/lib/datetime'
import { cn } from '~/lib/utils'
import type { CommentThreadView } from '~/lib/comments'
import { CommentMessageItem } from './comment-message-item'
import {
  CommentReplyComposer,
  CommentResolveButton,
  CommentStatusBadge,
  CommentThreadActionsMenu,
  CommentThreadDeleteDialog,
} from './comment-thread-parts'
import { useCommentMutations } from './use-comment-mutations'
import {
  commentReplyReducer,
  createCommentReplyState,
} from './comment-reply-state'
import { IconMessage, IconX } from '@tabler/icons-react'
import { useAnalyticsConsent } from '~/components/app/analytics-consent-provider'

type CommentFilter = 'open' | 'all' | 'resolved'
type TargetThreadScroll = 'center' | 'start'

const COMMENT_PAGE_SIZE = 50
const COLLAPSED_REPLY_COUNT = 3
const EXPANDED_REPLY_PAGE_SIZE = 50

interface CommentPanelProps {
  shareableId: string
  viewerUserId: string
  threads: ReadonlyArray<CommentThreadView>
  onThreadsChange: (threads: ReadonlyArray<CommentThreadView>) => void
  isCurrentShareableId: (shareableId: string) => boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  targetThreadId: string | null
  targetThreadScroll: TargetThreadScroll
  onThreadNavigate: (thread: CommentThreadView) => void
  returnFocusRef?: RefObject<HTMLElement | null>
  requestedFilter?: CommentFilter
  // 本文選択できない成果物 (static_site) 向けに、ファイル全体への
  // コメントを新規作成する composer をパネル下部に出す。
  showNewThreadComposer?: boolean
}

export function CommentPanel({
  shareableId,
  viewerUserId,
  threads,
  onThreadsChange,
  isCurrentShareableId,
  open,
  onOpenChange,
  targetThreadId,
  targetThreadScroll,
  onThreadNavigate,
  returnFocusRef,
  requestedFilter,
  showNewThreadComposer = false,
}: CommentPanelProps) {
  const translator = useT()
  const { setCommentPanelOpen } = useAnalyticsConsent()
  const { locale, t, tPlural } = translator
  const [filter, setFilter] = useState<CommentFilter>('open')
  const [previousRequestedFilter, setPreviousRequestedFilter] =
    useState(requestedFilter)
  const [activeRequestedFilter, setActiveRequestedFilter] =
    useState(requestedFilter)
  if (requestedFilter !== previousRequestedFilter) {
    setPreviousRequestedFilter(requestedFilter)
    setActiveRequestedFilter(requestedFilter)
  }
  const [replyState, dispatchReply] = useReducer(
    commentReplyReducer,
    undefined,
    createCommentReplyState,
  )
  const [threadLimitState, setThreadLimitState] = useState<{
    scope: string
    value: number
  } | null>(null)
  const [autoFilterTarget, setAutoFilterTarget] = useState<{
    key: string
    filter: CommentFilter
  } | null>(null)
  const wasOpenRef = useRef(open)
  useLayoutEffect(() => {
    setCommentPanelOpen(open)
    return () => setCommentPanelOpen(false)
  }, [open, setCommentPanelOpen])
  const { mutate, pendingKeys } = useCommentMutations({
    shareableId,
    isCurrentShareableId,
    onThreadsChange,
  })

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      returnFocusRef?.current?.focus()
    }
    wasOpenRef.current = open
  }, [open, returnFocusRef])

  const targetThread = useMemo(
    () => threads.find((thread) => thread.id === targetThreadId),
    [targetThreadId, threads],
  )
  const targetThreadFilterKey = targetThread
    ? `${targetThread.id}:${targetThread.status}`
    : null

  if (!targetThreadId && autoFilterTarget !== null) {
    setAutoFilterTarget(null)
  }
  if (
    open &&
    targetThread &&
    filter !== 'all' &&
    filter !== targetThread.status &&
    autoFilterTarget?.key !== targetThreadFilterKey
  ) {
    setAutoFilterTarget({
      key: targetThreadFilterKey ?? targetThread.id,
      filter: targetThread.status,
    })
  }
  const visibleFilter = activeRequestedFilter
    ? activeRequestedFilter
    : open &&
        targetThreadFilterKey &&
        autoFilterTarget?.key === targetThreadFilterKey
      ? autoFilterTarget.filter
      : filter

  const visibleThreads = useMemo(() => {
    const filtered =
      visibleFilter === 'all'
        ? threads
        : threads.filter((thread) => thread.status === visibleFilter)
    return Array.from(filtered).sort(compareCommentThreads)
  }, [threads, visibleFilter])

  const threadLimitScope = `${shareableId}:${visibleFilter}`
  const manualThreadLimit =
    threadLimitState?.scope === threadLimitScope
      ? threadLimitState.value
      : COMMENT_PAGE_SIZE
  const targetThreadLimit = targetThreadId
    ? visibleThreads.findIndex((thread) => thread.id === targetThreadId) + 1
    : 0
  const threadLimit = Math.max(
    manualThreadLimit,
    Math.ceil(targetThreadLimit / COMMENT_PAGE_SIZE) * COMMENT_PAGE_SIZE,
  )

  const displayedThreads = visibleThreads.slice(0, threadLimit)
  const hiddenThreadCount = Math.max(
    0,
    visibleThreads.length - displayedThreads.length,
  )

  const commentList = (
    <div className="pb-comment-panel-bottom flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-3 pt-3">
      {visibleThreads.length === 0 ? (
        <div className="bg-muted border-border flex flex-col gap-1 rounded-[var(--r-md)] border p-3.5">
          <strong className="text-sm">{t('comments.emptyTitle')}</strong>
          <span className="text-muted-foreground text-sm leading-(--lh-loose)">
            {t(
              showNewThreadComposer
                ? 'comments.emptyBodyArtifact'
                : 'comments.emptyBody',
            )}
          </span>
        </div>
      ) : (
        <>
          {displayedThreads.map((thread) => (
            <ThreadCard
              key={thread.id}
              thread={thread}
              locale={locale}
              target={thread.id === targetThreadId}
              targetScroll={targetThreadScroll}
              pendingKeys={pendingKeys}
              onReply={(body) =>
                mutate(
                  { intent: 'reply', threadId: thread.id, body },
                  `reply:${thread.id}`,
                ).then((success) => {
                  dispatchReply({
                    type: 'settled',
                    threadId: thread.id,
                    submittedBody: body,
                    success,
                  })
                  return success
                })
              }
              replyOpen={replyState.activeThreadId === thread.id}
              replyBody={replyState.drafts[thread.id] ?? ''}
              onReplyOpen={() =>
                dispatchReply({ type: 'open', threadId: thread.id })
              }
              onReplyChange={(value) =>
                dispatchReply({ type: 'change', threadId: thread.id, value })
              }
              onReplyCancel={() => dispatchReply({ type: 'cancel' })}
              onResolve={() =>
                void mutate(
                  {
                    intent: thread.status === 'resolved' ? 'reopen' : 'resolve',
                    threadId: thread.id,
                  },
                  `resolve:${thread.id}`,
                )
              }
              onUpdateMessage={(messageId, body) =>
                mutate(
                  { intent: 'update-message', messageId, body },
                  `message:${messageId}`,
                )
              }
              onDeleteMessage={(messageId) =>
                mutate(
                  { intent: 'delete-message', messageId },
                  `message:${messageId}`,
                )
              }
              onDeleteThread={() =>
                mutate(
                  { intent: 'delete-thread', threadId: thread.id },
                  `thread:${thread.id}`,
                )
              }
              onCopyLink={() => {
                copyShareUrl(
                  commentDeepLinkUrl(window.location.href, thread.id),
                  translator,
                )
              }}
              onNavigate={() => onThreadNavigate(thread)}
            />
          ))}
          {hiddenThreadCount > 0 ? (
            <button
              type="button"
              className="bg-background text-foreground hover:bg-accent border-divider grid cursor-pointer justify-items-center gap-0.5 rounded-[var(--r-lg)] border p-2.5"
              onClick={() =>
                setThreadLimitState({
                  scope: threadLimitScope,
                  value: threadLimit + COMMENT_PAGE_SIZE,
                })
              }
            >
              <strong className="text-link text-xs font-bold">
                {t('comments.loadMoreThreads')}
              </strong>
              <span className="text-muted-foreground text-xs">
                {tPlural('comments.remainingThreadCount', hiddenThreadCount)}
              </span>
            </button>
          ) : null}
        </>
      )}
    </div>
  )

  return (
    <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        onInteractOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => {
          if (
            replyState.activeThreadId &&
            visibleThreads.some(
              (thread) =>
                thread.id === replyState.activeThreadId &&
                thread.status === 'open',
            )
          ) {
            event.preventDefault()
            dispatchReply({
              type: 'cancel',
            })
          }
        }}
        className="max-sheet:inset-x-2.5 max-sheet:top-auto max-sheet:bottom-0 max-sheet:h-[var(--height-comment-panel-sheet)] max-sheet:w-auto max-sheet:max-w-none max-sheet:rounded-t-[var(--r-lg)] max-sheet:border-t-divider max-sheet:border-r-divider max-sheet:border-l-divider gap-0"
        aria-describedby={undefined}
      >
        <CommentPanelHeader />

        <Tabs
          className="flex min-h-0 flex-1 flex-col"
          value={visibleFilter}
          onValueChange={(value) => {
            const item = value as CommentFilter
            setActiveRequestedFilter(undefined)
            setAutoFilterTarget(
              targetThreadFilterKey
                ? { key: targetThreadFilterKey, filter: item }
                : null,
            )
            setFilter(item)
          }}
        >
          <TabsList aria-label={t('comments.filterLabel')}>
            {(['open', 'all', 'resolved'] as const).map((item) => (
              <TabsTrigger key={item} value={item}>
                {t(`comments.filter.${item}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          {(['open', 'all', 'resolved'] as const).map((item) => (
            <TabsContent
              key={item}
              value={item}
              className="flex min-h-0 flex-1 flex-col"
            >
              {commentList}
            </TabsContent>
          ))}
        </Tabs>
        {showNewThreadComposer ? (
          <NewThreadComposer
            pending={pendingKeys.has('create-thread')}
            onSubmit={(body) =>
              mutate({ intent: 'create-thread', body }, 'create-thread')
            }
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function CommentPanelHeader() {
  const { t } = useT()
  return (
    <SheetHeader>
      <SheetTitle>
        <IconMessage size={16} aria-hidden="true" />
        <span>{t('comments.title')}</span>
      </SheetTitle>
      <SheetClose asChild>
        <IconButton
          type="button"
          icon={IconX}
          size="md"
          aria-label={t('common.close')}
        />
      </SheetClose>
    </SheetHeader>
  )
}

function NewThreadComposer({
  pending,
  onSubmit,
}: {
  pending: boolean
  onSubmit: (body: string) => Promise<boolean>
}) {
  const { t } = useT()
  const [body, setBody] = useState('')
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!body.trim()) return
    if (await onSubmit(body)) setBody('')
  }
  return (
    <form
      className="bg-background border-border border-t p-3"
      onSubmit={submit}
    >
      <Textarea
        className="text-foreground min-h-comment-textarea border-divider bg-card w-full resize-y rounded-[var(--r-lg)] p-2.5 text-sm"
        value={body}
        maxLength={MAX_COMMENT_BODY_LENGTH}
        aria-label={t('comments.newLabel')}
        placeholder={t('comments.newArtifactPlaceholder')}
        onChange={(event) => setBody(event.currentTarget.value)}
      />
      <div className="mt-2 flex justify-end gap-2">
        <Button
          type="submit"
          variant="default"
          size="sm"
          disabled={!body.trim() || pending}
        >
          {t('comments.post')}
        </Button>
      </div>
    </form>
  )
}

function ThreadCard({
  thread,
  locale,
  target,
  targetScroll,
  pendingKeys,
  onReply,
  onResolve,
  onUpdateMessage,
  onDeleteMessage,
  onDeleteThread,
  onCopyLink,
  onNavigate,
  replyOpen,
  replyBody,
  onReplyOpen,
  onReplyChange,
  onReplyCancel,
}: {
  thread: CommentThreadView
  locale: Parameters<typeof formatRelative>[1]
  target: boolean
  targetScroll: TargetThreadScroll
  pendingKeys: ReadonlySet<string>
  onReply: (body: string) => Promise<boolean>
  onResolve: () => void
  onUpdateMessage: (messageId: string, body: string) => Promise<boolean>
  onDeleteMessage: (messageId: string) => Promise<boolean>
  onDeleteThread: () => Promise<boolean>
  onCopyLink: () => void
  onNavigate: () => void
  replyOpen: boolean
  replyBody: string
  onReplyOpen: () => void
  onReplyChange: (value: string) => void
  onReplyCancel: () => void
}) {
  const { t, tPlural } = useT()
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [repliesExpanded, setRepliesExpanded] = useState(false)
  const [replyLimit, setReplyLimit] = useState(EXPANDED_REPLY_PAGE_SIZE)
  const pendingReply = pendingKeys.has(`reply:${thread.id}`)
  const pendingResolve = pendingKeys.has(`resolve:${thread.id}`)
  const pendingDelete = pendingKeys.has(`thread:${thread.id}`)
  const threadRef = useRef<HTMLElement | null>(null)
  const replyRef = useRef<HTMLTextAreaElement | null>(null)
  const navigationPointerRef = useRef<{
    pointerId: number
    x: number
    y: number
  } | null>(null)
  const firstMessage = thread.messages[0]
  const replyMessages = thread.messages.slice(1)

  useLayoutEffect(() => {
    if (!target) return
    threadRef.current?.scrollIntoView({ block: targetScroll })
  }, [target, targetScroll])

  useLayoutEffect(() => {
    if (replyOpen) replyRef.current?.focus({ preventScroll: true })
  }, [replyOpen])

  const submitReply = async () => {
    if (!replyBody.trim()) return
    await onReply(replyBody)
  }

  const confirmDeleteThread = async () => {
    if (await onDeleteThread()) setDeleteConfirmOpen(false)
  }

  const showAllReplies = target || repliesExpanded
  const hiddenReplyCount = showAllReplies
    ? Math.max(0, replyMessages.length - replyLimit)
    : Math.max(0, replyMessages.length - COLLAPSED_REPLY_COUNT)
  const displayedReplyMessages = showAllReplies
    ? replyMessages.slice(-replyLimit)
    : replyMessages.slice(-COLLAPSED_REPLY_COUNT)
  const canNavigateToText =
    thread.subject.kind === 'text' && thread.subject.state === 'attached'

  return (
    <article
      ref={threadRef}
      className={cn(
        'bg-background scroll-m-scroll-anchor-sm has-[[data-comment-thread-hitarea]:focus-visible]:ring-ring/50 border-border has-[[data-comment-thread-hitarea]:focus-visible]:border-link relative grid max-w-full min-w-0 flex-none gap-2 overflow-hidden rounded-[var(--r-lg)] border p-3 has-[[data-comment-thread-hitarea]:focus-visible]:ring-3',
        canNavigateToText &&
          'cursor-pointer [&>[data-thread-content]]:relative [&>[data-thread-content]]:z-1',
        target &&
          'ring-ring/50 border-link bg-[linear-gradient(180deg,color-mix(in_srgb,var(--link)_10%,var(--background)),var(--background)_42%)] ring-3',
        thread.status === 'resolved' &&
          'text-muted-foreground bg-[color-mix(in_srgb,var(--success)_7%,var(--background))]',
      )}
      // A full-size button below provides the keyboard target. Pointer capture
      // complements it for taps on non-interactive content without turning the
      // article containing other controls into a button.
      onPointerDownCapture={(event) => {
        navigationPointerRef.current = null
        if (!canNavigateToText || !event.isPrimary || event.button !== 0) return
        if (isThreadNavigationHandledByChild(event.target)) return
        navigationPointerRef.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
        }
      }}
      onPointerUpCapture={(event) => {
        const start = navigationPointerRef.current
        navigationPointerRef.current = null
        if (!start || start.pointerId !== event.pointerId) return
        if (
          Math.abs(event.clientX - start.x) > 5 ||
          Math.abs(event.clientY - start.y) > 5
        )
          return
        onNavigate()
      }}
      onPointerCancel={() => {
        navigationPointerRef.current = null
      }}
    >
      {canNavigateToText ? (
        <button
          type="button"
          className="absolute inset-0 z-0 cursor-pointer border-0 bg-transparent focus-visible:outline-0"
          data-comment-thread-hitarea=""
          aria-label={t('comments.goToText')}
          onClick={onNavigate}
        />
      ) : null}
      <div
        className="flex min-w-0 items-center justify-between gap-2.5"
        data-thread-content=""
      >
        <CommentStatusBadge status={thread.status} />
        <div className="inline-flex shrink-0 items-center gap-1">
          {thread.canResolve ? (
            <CommentResolveButton
              status={thread.status}
              pending={pendingResolve}
              disabled={Boolean(replyOpen && replyBody.trim())}
              variant="panel"
              onResolve={onResolve}
            />
          ) : null}
          <CommentThreadActionsMenu
            variant="panel"
            canDelete={thread.canResolve}
            pendingDelete={pendingDelete}
            canNavigateToText={canNavigateToText}
            onNavigate={onNavigate}
            onCopyLink={onCopyLink}
            onDeleteRequest={() => setDeleteConfirmOpen(true)}
          />
          {thread.canResolve ? (
            <CommentThreadDeleteDialog
              open={deleteConfirmOpen}
              pending={pendingDelete}
              onOpenChange={setDeleteConfirmOpen}
              onConfirm={() => void confirmDeleteThread()}
            />
          ) : null}
        </div>
      </div>
      <div data-thread-content="">
        <ThreadSubject thread={thread} />
      </div>
      {firstMessage ? (
        <div className="min-w-0" data-thread-content="">
          <CommentMessageItem
            message={firstMessage}
            locale={locale}
            pending={pendingKeys.has(`message:${firstMessage.id}`)}
            onUpdate={onUpdateMessage}
            onDelete={onDeleteMessage}
          />
        </div>
      ) : null}
      {replyMessages.length > 0 ? (
        <div
          className="before:top-timeline-top before:left-timeline-offset border-border relative mt-0.5 grid min-w-0 gap-2.5 border-t pt-2.5 pl-5 before:absolute before:bottom-0.5 before:w-0.5 before:rounded-full before:bg-[color-mix(in_srgb,var(--link)_22%,var(--divider))]"
          data-thread-content=""
        >
          {hiddenReplyCount > 0 ? (
            <button
              type="button"
              className="text-link justify-self-start border-0 bg-transparent p-0 text-xs font-bold hover:underline"
              onClick={() => {
                if (!showAllReplies) {
                  setRepliesExpanded(true)
                  setReplyLimit(EXPANDED_REPLY_PAGE_SIZE)
                  return
                }
                setReplyLimit((current) =>
                  Math.min(
                    replyMessages.length,
                    current + EXPANDED_REPLY_PAGE_SIZE,
                  ),
                )
              }}
            >
              {tPlural('comments.previousReplyCount', hiddenReplyCount)}
            </button>
          ) : null}
          {displayedReplyMessages.map((message) => (
            <CommentMessageItem
              key={message.id}
              message={message}
              locale={locale}
              pending={pendingKeys.has(`message:${message.id}`)}
              onUpdate={onUpdateMessage}
              onDelete={onDeleteMessage}
            />
          ))}
        </div>
      ) : null}
      {thread.status === 'open' && replyOpen ? (
        <div data-thread-content="">
          <CommentReplyComposer
            variant="panel"
            value={replyBody}
            pending={pendingReply}
            inputRef={replyRef}
            onChange={onReplyChange}
            onCancel={onReplyCancel}
            onSubmit={submitReply}
          />
        </div>
      ) : thread.status === 'open' ? (
        <div data-thread-content="">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onReplyOpen}
          >
            {t('comments.reply')}
          </Button>
        </div>
      ) : null}
    </article>
  )
}

function isThreadNavigationHandledByChild(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target.closest('[data-comment-thread-hitarea]')) return true
  return Boolean(
    target.closest(
      [
        'a',
        'button',
        'input',
        'select',
        'textarea',
        '[contenteditable="true"]',
        '[data-slot="alert-dialog-content"]',
        '[data-slot="dropdown-menu-content"]',
        '[role="button"]',
        '[role="menuitem"]',
      ].join(','),
    ),
  )
}

function ThreadSubject({ thread }: { thread: CommentThreadView }) {
  const { t } = useT()
  if (thread.subject.kind === 'artifact') {
    return (
      <div className="text-link p-0 text-xs font-semibold">
        {t('comments.subjectArtifact')}
      </div>
    )
  }
  const attached = thread.subject.state === 'attached'
  return (
    <div
      className={cn(
        'py-comment-block text-link grid rounded-[var(--r-lg)] border border-[color-mix(in_srgb,var(--link)_34%,var(--divider))] bg-transparent px-2.5 text-xs font-normal',
        !attached &&
          'text-warning border-[color-mix(in_srgb,var(--warning)_36%,var(--divider))] bg-[color-mix(in_srgb,var(--warning)_10%,var(--background))]',
      )}
    >
      <strong className="hidden">
        {t(attached ? 'comments.subjectText' : 'comments.subjectOrphaned')}
      </strong>
      <span className="[overflow-wrap:anywhere]">
        {quoteCommentText(thread.subject.quotedText)}
      </span>
    </div>
  )
}

function compareCommentThreads(
  left: CommentThreadView,
  right: CommentThreadView,
): number {
  const rank = (thread: CommentThreadView) => {
    if (thread.subject.kind === 'text' && thread.subject.state === 'attached') {
      return 0
    }
    if (thread.subject.kind === 'artifact') return 1
    return 2
  }
  const rankDiff = rank(left) - rank(right)
  if (rankDiff !== 0) return rankDiff
  return right.messages.length - left.messages.length
}
