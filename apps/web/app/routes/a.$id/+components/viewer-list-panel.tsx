import { IconEye, IconX } from '@tabler/icons-react'
import { useEffect, useRef, type RefObject } from 'react'
import { SheetClose, SheetHeader, SheetTitle } from '~/components/ui/sheet'
import { Button } from '~/components/ui/button'
import { IconButton } from '~/components/app/icon-button'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { useT } from '~/hooks/use-t'
import { useLatestRef } from '~/hooks/use-latest-ref'
import { isUtcZTimestamp } from '~/lib/datetime'
import { useRelativeTime } from '~/components/app/render-clock'
import type { Locale } from '~/i18n/messages'
import type {
  ViewerListRowView,
  ViewerListStatus,
} from '../+hooks/use-viewer-list'
import { AppSidePanel } from '~/components/app/app-side-panel'

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
  closeReason?: 'user' | 'forced' | null
  skipReturnFocus?: boolean
  topbarCollapsed?: boolean
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
  topbarCollapsed = false,
}: ViewerListPanelProps) {
  const translator = useT()
  const { t, tPlural, locale } = translator
  const wasOpenRef = useRef(open)
  const skipReturnFocusRef = useLatestRef(skipReturnFocus)
  const closeReasonRef = useLatestRef(closeReason)

  useEffect(() => {
    if (wasOpenRef.current && !open) {
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
  }, [closeReasonRef, open, returnFocusRef, skipReturnFocusRef])

  return (
    <AppSidePanel
      open={open}
      onOpenChange={onOpenChange}
      topbar={topbarCollapsed ? 'none' : 'viewer'}
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
    </AppSidePanel>
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
  locale: Locale
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
  locale: Locale
  t: ReturnType<typeof useT>['t']
}) {
  const formatRelative = useRelativeTime()
  const trimmedName = (row.name ?? '').trim()
  const name = trimmedName === '' ? t('home.unknownActor') : trimmedName
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
      {row.isExternal ? (
        <span className="bg-muted text-muted-foreground rounded-[var(--r-sm)] px-1 text-xs">
          {t('vw.viewerListExternal')}
        </span>
      ) : null}
      <span className="text-muted-foreground shrink-0 text-xs">
        {lastViewedLabel}
      </span>
    </div>
  )
}
