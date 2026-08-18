import { IconEye, IconX } from '@tabler/icons-react'
import { useEffect, useRef, type RefObject } from 'react'
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '~/components/ui/sheet'
import { Button } from '~/components/ui/button'
import { IconButton } from '~/components/app/icon-button'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { useT } from '~/hooks/use-t'
import { formatRelative, isUtcZTimestamp } from '~/lib/datetime'
import type {
  ViewerListRowView,
  ViewerListStatus,
} from '../+hooks/use-viewer-list'

// イニシャルは trim 後の先頭 1 文字を大文字化、空なら「?」。
// `getOwnerInitial` はメールへフォールバックするためここでは使わない。
export function viewerListInitial(name: string | null): string {
  const trimmed = (name ?? '').trim()
  if (trimmed === '') return '?'
  const first = [...trimmed][0] ?? '?'
  return first.toLocaleUpperCase()
}

interface ViewerListPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: ReadonlyArray<ViewerListRowView>
  totalViewers: number | null
  status: ViewerListStatus
  loadingMore: boolean
  nextCursor: string | null
  onLoadMore: () => void
  onRetry: () => void
  returnFocusRef?: RefObject<HTMLElement | null>
  // 閉鎖理由。'forced' (comments/history 排他や artifact 切替) のときは
  // フォーカスを入口へ戻さない (直後に開くパネルからフォーカスを奪わない)。
  // 省略時は user 操作扱い。
  closeReason?: 'user' | 'forced' | null
  // chrome 折りたたみ中は入口が不可視のためフォーカス復帰をスキップする。
  skipReturnFocus?: boolean
}

export function ViewerListPanel({
  open,
  onOpenChange,
  rows,
  totalViewers,
  status,
  loadingMore,
  nextCursor,
  onLoadMore,
  onRetry,
  returnFocusRef,
  closeReason,
  skipReturnFocus = false,
}: ViewerListPanelProps) {
  const translator = useT()
  const { t, tPlural, locale } = translator
  const wasOpenRef = useRef(open)
  const skipReturnFocusRef = useRef(skipReturnFocus)
  skipReturnFocusRef.current = skipReturnFocus
  const closeReasonRef = useRef(closeReason)
  closeReasonRef.current = closeReason

  useEffect(() => {
    if (wasOpenRef.current && !open) {
      // comment/history パネルは無条件で focus() するが、このパネルは
      // 意図的に分岐する: 強制閉鎖 (closeReason 'forced' = 排他や artifact
      // 切替) では直後に開くパネルからフォーカスを奪わない。入口は chrome
      // 折りたたみで不可視になり、artifact 切替で対象が DOM から外れるため
      // skipReturnFocus / !isConnected でもスキップする。
      const target = returnFocusRef?.current ?? null
      if (
        closeReasonRef.current !== 'forced' &&
        !skipReturnFocusRef.current &&
        target?.isConnected
      ) {
        target.focus()
      }
    }
    wasOpenRef.current = open
  }, [open, returnFocusRef])

  return (
    <Sheet modal={false} open={open} onOpenChange={onOpenChange}>
      <SheetContent
        onInteractOutside={(event) => event.preventDefault()}
        className="max-sheet:inset-x-2.5 max-sheet:top-auto max-sheet:bottom-0 max-sheet:h-[var(--height-comment-panel-sheet)] max-sheet:w-auto max-sheet:max-w-none max-sheet:rounded-t-[var(--r-lg)] max-sheet:border-t-divider max-sheet:border-r-divider max-sheet:border-l-divider gap-0"
        aria-describedby={undefined}
      >
        <SheetHeader>
          <SheetTitle>
            <IconEye size={16} aria-hidden="true" />
            <span>
              {totalViewers === null
                ? t('vw.viewerListMenuItem')
                : tPlural('vw.viewerListPanelTitle', totalViewers)}
            </span>
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
        <ViewerListPanelBody
          rows={rows}
          status={status}
          loadingMore={loadingMore}
          nextCursor={nextCursor}
          onLoadMore={onLoadMore}
          onRetry={onRetry}
          locale={locale}
          t={t}
        />
      </SheetContent>
    </Sheet>
  )
}

export function ViewerListPanelBody({
  rows,
  status,
  loadingMore,
  nextCursor,
  onLoadMore,
  onRetry,
  locale,
  t,
}: {
  rows: ReadonlyArray<ViewerListRowView>
  status: ViewerListStatus
  loadingMore: boolean
  nextCursor: string | null
  onLoadMore: () => void
  onRetry: () => void
  locale: Parameters<typeof formatRelative>[1]
  t: ReturnType<typeof useT>['t']
}) {
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-3.5">
        {status === 'loading' || status === 'idle' ? (
          <span className="text-muted-foreground text-sm">
            {t('vw.viewerListLoading')}
          </span>
        ) : status === 'error' ? (
          <div className="flex flex-col items-start gap-2">
            <span className="text-muted-foreground text-sm">
              {t('vw.viewerListError')}
            </span>
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('vw.viewerListRetry')}
            </Button>
          </div>
        ) : rows.length === 0 ? (
          <span className="text-muted-foreground text-sm">
            {t('vw.viewerListEmpty')}
          </span>
        ) : (
          <>
            {rows.map((row) => (
              <ViewerListRowItem
                key={row.userId}
                row={row}
                locale={locale}
                t={t}
              />
            ))}
            {nextCursor ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="self-start"
                disabled={loadingMore}
                onClick={onLoadMore}
              >
                {t('vw.viewerListLoadMore')}
              </Button>
            ) : null}
          </>
        )}
      </div>
      <div className="border-divider text-muted-foreground flex flex-col gap-1 border-t p-3.5 text-xs leading-(--lh-loose)">
        <span>{t('vw.viewerListFooterReciprocity')}</span>
        <span>{t('vw.viewerListFooterScope')}</span>
        <span>{t('vw.viewerListFooterNotRead')}</span>
      </div>
    </>
  )
}

function ViewerListRowItem({
  row,
  locale,
  t,
}: {
  row: ViewerListRowView
  locale: Parameters<typeof formatRelative>[1]
  t: ReturnType<typeof useT>['t']
}) {
  const trimmedName = (row.name ?? '').trim()
  const name = trimmedName === '' ? t('home.unknownActor') : trimmedName
  // 非 canonical な日時 (オフセット付き ISO、空白区切りなど) は相対時刻に
  // せず「—」を表示する (ローカル誤解釈と Invalid Date を防ぐ)。
  const lastViewedLabel = isUtcZTimestamp(row.lastViewedAt)
    ? formatRelative(row.lastViewedAt, locale)
    : '—'
  return (
    <div className="flex min-w-0 items-center gap-2 py-1">
      <AuthorAvatar
        id={row.userId}
        image={row.image}
        initial={viewerListInitial(row.name)}
        size="sm"
      />
      <span className="min-w-0 flex-1 truncate text-sm" title={name}>
        {name}
      </span>
      {row.isSelf ? (
        <span className="bg-muted text-muted-foreground rounded-[var(--r-sm)] px-1 text-xs">
          {t('card.me')}
        </span>
      ) : null}
      <span className="text-muted-foreground shrink-0 text-xs">
        {lastViewedLabel}
      </span>
    </div>
  )
}
