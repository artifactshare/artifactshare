import type { RefObject } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { IconLock } from '@tabler/icons-react'
import type { FileRowData } from './file-data'
import type { RecentRow, RestrictedRecentRow } from '~/lib/recent-row'
import { EmptyState } from './empty-state'
import { FileRow } from './file-row'
import { FileRowDialogs, useFileRowActions } from './file-row-dialogs'
import {
  fileTableHeadClassName,
  fileTableListClassName,
  homeActionsClassName,
  homeHeadClassName,
  homeHeadTitleClassName,
  homeSectionClassName,
  homeCompactLostAccessColumns,
  dateRailRestrictedColumns,
  projectMetaClassName,
} from './file-list-styles'
import {
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '~/components/ui/breadcrumb'
import { PageBreadcrumb } from '~/components/app/page-breadcrumb'
import { useT } from '~/hooks/use-t'
import {
  AppPageHeader,
  AppPageHeaderMain,
  AppPageHeaderMeta,
  AppPageHeaderTitle,
  AppPageHeaderTitleRow,
} from '~/components/app/app-page-header'
import { AppDividerList } from '~/components/app/app-divider-list'
import { AppMoreLink } from '~/components/app/app-more-link'
import { cn } from '~/lib/utils'
import { focusReturnTargetClassName } from '~/components/app/page-shell-styles'
import {
  fileDateHeadingClassName,
  fileTableColumns,
  fileTableColumnsActions,
} from './file-list-styles'
import { recentUrl } from '~/lib/recent-query'
import { Button } from '~/components/ui/button'
import { useViewerCalendar } from '~/hooks/use-viewer-calendar'
import {
  groupByDay,
  isUtcZTimestamp,
  localDayKeyFromTimezone,
  recentDatePresentation,
  type RecentDatePresentation,
} from '~/lib/datetime'

export interface RecentContentLayout {
  signedIn: boolean
  workspaceName: string
  selfUploadEnabled: boolean
  openUploadDialog: () => void
  user?: { name: string | null; email: string }
}

export interface RecentContentProps {
  layoutData: RecentContentLayout
  files: RecentRow[] | FileRowData[]
  relation?: 'all' | 'own' | 'project' | 'shared'
  unread?: boolean
  mainRef?: RefObject<HTMLDivElement | null>
  total?: number
  page?: number
  isBusy?: boolean
  hasHiddenHistory?: boolean
  historyCardinality?: number
  now?: string
  /** この route loader が評価したフラグ。`recentRowActivitySelects` で出し分けた
   * 列 (版数・最新版・未読 2 列) を読む表示は、すべてこの値でゲートする。親 layout の
   * 評価とずれると、列が無いのに表示しようとする不整合になる */
  unreadEnabled?: boolean
  pagination?: boolean
  error?: boolean
  homeCompact?: boolean
  singleLineTitle?: boolean
  dateRail?: boolean
  olderHistoryLink?: boolean
}

export function RecentListBody({
  files,
  relation = 'all',
  unread = false,
  total = files.length,
  page = 1,
  isBusy = false,
  historyCardinality,
  now,
  unreadEnabled = false,
  pagination = false,
  error = false,
  homeCompact = false,
  singleLineTitle = false,
  dateRail = false,
  olderHistoryLink = false,
}: Omit<
  RecentContentProps,
  'layoutData' | 'query' | 'onQueryChange' | 'mainRef'
>) {
  const { t, locale } = useT()
  const location = useLocation()
  const rowActions = useFileRowActions()
  const rows: RecentRow[] = files.map((row) =>
    'kind' in row ? row : { kind: 'file', file: row },
  )
  const { hydrated, timeZone } = useViewerCalendar()
  const groups = hydrated
    ? groupByDay(
        rows,
        (row) =>
          row.kind === 'file'
            ? (row.file.modifiedTime ?? '')
            : (row.lastViewedAt ?? ''),
        locale,
        new Date(now ?? new Date().toISOString()),
        timeZone,
      )
    : null
  const rowDates = new Map<RecentRow, RecentDatePresentation>()
  let previousDayKey = ''
  if (dateRail && hydrated && now) {
    for (const row of rows) {
      const timestamp =
        row.kind === 'file' ? row.file.modifiedTime : row.lastViewedAt
      const dayKey =
        timestamp && isUtcZTimestamp(timestamp)
          ? localDayKeyFromTimezone(timestamp, timeZone)
          : ''
      const formatted = dayKey
        ? recentDatePresentation(dayKey, locale, new Date(now), timeZone)
        : null
      if (!formatted) {
        rowDates.set(row, { label: null, compactLabel: null, fullDate: null })
        continue
      }
      const firstOfDay = dayKey !== previousDayKey
      previousDayKey = dayKey
      rowDates.set(row, {
        ...formatted,
        label: firstOfDay ? formatted.label : null,
        compactLabel: firstOfDay ? formatted.compactLabel : null,
      })
    }
  }
  const resetUrl = recentUrl({
    pathname: location.pathname,
    hash: location.hash,
  })
  const isFiltered = relation !== 'all' || unread
  const cardinality =
    historyCardinality ?? (files.length > 1 ? 2 : files.length)
  const showOneItemHint = !isFiltered && cardinality === 1
  const emptyState = isFiltered ? (
    <div>
      <EmptyState variant="recent" filtered />
      <p className="text-center">
        <Link className="text-link underline" to={resetUrl}>
          {t('recent.reset')}
        </Link>
      </p>
    </div>
  ) : (
    <EmptyState variant="recent" hasHiddenHistory={false} />
  )
  return (
    <div
      aria-busy={isBusy}
      data-recent-hydrated={dateRail && hydrated ? '' : undefined}
    >
      <nav
        aria-label={t('recent.filters')}
        className="mb-4 flex flex-wrap items-center gap-2"
      >
        <div className="max-phone:w-full max-phone:overflow-x-auto max-phone:flex-nowrap flex min-w-0 gap-2">
          {(['all', 'own', 'project', 'shared'] as const).map((value) => (
            <Link
              key={value}
              to={recentUrl({
                pathname: location.pathname,
                relation: value,
                unread,
                hash: location.hash,
              })}
              aria-current={relation === value ? 'page' : undefined}
              className={cn(
                'rounded-full border px-3 py-1 text-sm whitespace-nowrap no-underline',
                relation === value
                  ? 'border-link bg-link-soft text-link font-medium'
                  : 'border-divider text-muted-foreground hover:bg-accent',
              )}
            >
              {t(`recent.relation.${value}`)}
            </Link>
          ))}
        </div>
        <Link
          to={recentUrl({
            pathname: location.pathname,
            relation,
            unread: !unread,
            hash: location.hash,
          })}
          role="switch"
          aria-checked={unread}
          className="max-phone:basis-full max-phone:ml-0 border-divider hover:bg-accent ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm whitespace-nowrap no-underline"
        >
          <span
            aria-hidden="true"
            className={cn(
              'bg-muted relative inline-flex h-4 w-7 shrink-0 rounded-full transition-colors',
              unread && 'bg-link',
            )}
          >
            <span
              className={cn(
                'bg-background absolute top-0.5 left-0.5 size-3 rounded-full transition-transform',
                unread && 'translate-x-3',
              )}
            />
          </span>
          {t('recent.unread')}
        </Link>
      </nav>
      {error ? (
        <p className="text-muted-foreground text-sm">
          {t('recent.failure')}{' '}
          <a href="." className="underline">
            {t('home.reload')}
          </a>
        </p>
      ) : null}
      {!error && showOneItemHint ? (
        <p className="text-muted-foreground mb-4 text-sm">
          {t('recent.oneItemHint')}
        </p>
      ) : null}
      {!error &&
        (files.length === 0 ? (
          emptyState
        ) : (
          <AppDividerList
            className={cn(
              fileTableListClassName,
              homeCompact && '@container',
              dateRail && 'gap-0',
            )}
          >
            {(dateRail
              ? [{ key: 'rail', heading: '', items: rows }]
              : (groups ?? [{ key: 'ssr', heading: '', items: rows }])
            ).map((group) => (
              <div key={group.key}>
                {group.heading ? (
                  <div
                    data-recent-date-heading
                    className={cn(
                      fileDateHeadingClassName,
                      homeCompact && 'max-stack:px-0',
                    )}
                  >
                    <h2>{group.heading}</h2>
                  </div>
                ) : null}
                {group.items.map((row) =>
                  row.kind === 'file' ? (
                    <FileRow
                      key={row.file.id}
                      data={row.file}
                      menuEnabled
                      richStats={unreadEnabled}
                      unreadBadges={unreadEnabled}
                      recencyPresentation={
                        unreadEnabled ? 'grouped-with-preview' : 'grouped'
                      }
                      inlineOwner
                      hideMobileVisibility
                      now={now}
                      homeCompact={homeCompact}
                      singleLineTitle={singleLineTitle}
                      dateRail={
                        dateRail
                          ? (rowDates.get(row) ?? {
                              label: null,
                              compactLabel: null,
                              fullDate: null,
                            })
                          : undefined
                      }
                      onAction={(action) => rowActions.open(action, row.file)}
                    />
                  ) : (
                    <RestrictedRow
                      key={row.shareableId}
                      row={row}
                      homeCompact={homeCompact}
                      dateRail={
                        dateRail
                          ? (rowDates.get(row) ?? {
                              label: null,
                              compactLabel: null,
                              fullDate: null,
                            })
                          : undefined
                      }
                    />
                  ),
                )}
              </div>
            ))}
          </AppDividerList>
        ))}
      {!error ? (
        <FileRowDialogs active={rowActions.active} onClose={rowActions.close} />
      ) : null}
      {!error && pagination && total > 20 ? (
        <nav
          aria-label={t('recent.pagination')}
          className="mt-5 flex items-center justify-between text-sm"
        >
          <Button variant="outline" size="sm" asChild>
            <Link
              to={
                page <= 1
                  ? recentUrl({ page, relation, unread, hash: location.hash })
                  : recentUrl({
                      page: page - 1,
                      relation,
                      unread,
                      hash: location.hash,
                    })
              }
              aria-disabled={page <= 1}
              tabIndex={page <= 1 ? -1 : undefined}
            >
              {t('recent.previous')}
            </Link>
          </Button>
          <span>
            {t('recent.page', { page, totalPages: Math.ceil(total / 20) })}
          </span>
          <Button variant="outline" size="sm" asChild>
            <Link
              to={
                page * 20 >= total
                  ? recentUrl({ page, relation, unread, hash: location.hash })
                  : recentUrl({
                      page: page + 1,
                      relation,
                      unread,
                      hash: location.hash,
                    })
              }
              aria-disabled={page * 20 >= total}
              tabIndex={page * 20 >= total ? -1 : undefined}
            >
              {t('recent.next')}
            </Link>
          </Button>
        </nav>
      ) : null}
      {!error && olderHistoryLink && total > 20 ? (
        <div className="border-divider mt-5 border-t pt-4 text-sm">
          <AppMoreLink
            className="text-link whitespace-nowrap underline underline-offset-4"
            to={recentUrl({ page: 2, relation, unread, hash: location.hash })}
          >
            {t('home.continueOlder', { n: total - 20 })}
          </AppMoreLink>
        </div>
      ) : null}
    </div>
  )
}

export function RecentContent({
  layoutData,
  files,
  relation = 'all',
  unread = false,
  mainRef,
  total = files.length,
  page = 1,
  isBusy = false,
  hasHiddenHistory = false,
  historyCardinality,
  now,
  unreadEnabled = false,
}: RecentContentProps) {
  const { t } = useT()
  const navigate = useNavigate()
  const location = useLocation()
  const rowActions = useFileRowActions()
  const rows: RecentRow[] = files.map((row) =>
    'kind' in row ? row : { kind: 'file', file: row },
  )
  const { locale } = useT()
  const { hydrated, timeZone } = useViewerCalendar()
  const groups = hydrated
    ? groupByDay(
        rows,
        (row) =>
          row.kind === 'file'
            ? (row.file.modifiedTime ?? '')
            : (row.lastViewedAt ?? ''),
        locale,
        new Date(now ?? new Date().toISOString()),
        timeZone,
      )
    : null

  if (!layoutData.signedIn) return null

  return (
    <div
      ref={mainRef}
      className={focusReturnTargetClassName}
      tabIndex={-1}
      aria-busy={isBusy}
    >
      <PageBreadcrumb aria-label={t('project.location')}>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/">{t('tb.home')}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{t('home.recentViewed')}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </PageBreadcrumb>
      <section className={homeSectionClassName}>
        <AppPageHeader>
          <AppPageHeaderMain>
            <AppPageHeaderTitleRow>
              <AppPageHeaderTitle>{t('home.recentViewed')}</AppPageHeaderTitle>
            </AppPageHeaderTitleRow>
            <AppPageHeaderMeta>{t('recent.order')}</AppPageHeaderMeta>
          </AppPageHeaderMain>
        </AppPageHeader>
      </section>
      <RecentListBody
        files={files}
        relation={relation}
        unread={unread}
        total={total}
        page={page}
        isBusy={isBusy}
        historyCardinality={historyCardinality}
        now={now}
        unreadEnabled={unreadEnabled}
        pagination
      />
    </div>
  )
}

function RestrictedRow({
  row,
  homeCompact = false,
  dateRail,
}: {
  row: RestrictedRecentRow
  homeCompact?: boolean
  dateRail?: RecentDatePresentation
}) {
  const { t } = useT()
  return (
    <div
      data-slot="restricted-recent-row"
      data-gap-audit-allow-touch={dateRail ? '' : undefined}
      className={`${dateRail ? dateRailRestrictedColumns : homeCompact ? homeCompactLostAccessColumns : fileTableColumnsActions} border-divider text-muted-foreground ${dateRail ? 'max-stack:px-0 px-3' : homeCompact ? 'max-wide:grid-cols-[minmax(0,1fr)] max-stack:px-0' : 'max-wide:grid-cols-[minmax(0,1fr)]'} grid min-h-15.5 items-center gap-4 border-b px-3.5 py-2.5 text-sm last:border-b-0`}
    >
      {dateRail ? <RestrictedDateCell presentation={dateRail} /> : null}
      <span
        className="inline-flex min-w-0 items-center gap-3"
        data-recent-main-cell={dateRail ? '' : undefined}
      >
        {dateRail?.fullDate ? (
          <span className="sr-only">
            {t('recent.viewedDate', { date: dateRail.fullDate })}
          </span>
        ) : null}
        <span className="bg-muted text-faint flex size-5 shrink-0 items-center justify-center rounded-sm">
          <IconLock size={14} aria-hidden="true" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1 overflow-hidden">
          <span
            className="text-foreground line-clamp-2 font-medium"
            title={row.title}
            data-recent-title-line={dateRail ? '' : undefined}
          >
            {row.title}
          </span>
          <span className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-1 text-xs">
            <span className="min-w-0 truncate">
              {dateRail?.compactLabel ? (
                <span
                  aria-hidden="true"
                  className="@min-recent-rail-collapse:hidden"
                >
                  {dateRail.compactLabel.replace('\n', ' ')} ·{' '}
                </span>
              ) : null}
              {row.ownerName ?? t('recent.unknownOwner')}
            </span>
            <span
              className={`${dateRail ? '@min-recent-rail-wide:hidden' : 'max-wide:inline-flex hidden'} border-divider bg-muted/60 shrink-0 rounded-full border px-2 py-0.5 leading-tight`}
              title={t('recent.restricted')}
            >
              {t('recent.restrictedShort')}
            </span>
          </span>
        </span>
      </span>
      <span
        className={`${dateRail ? '@max-recent-rail-wide:hidden @min-recent-rail-wide:inline-flex' : 'max-wide:hidden'} border-divider bg-muted/60 w-fit items-center rounded-full border px-2 py-0.5 text-xs leading-tight`}
        title={t('recent.restricted')}
      >
        {t('recent.restrictedShort')}
      </span>
    </div>
  )
}

function RestrictedDateCell({
  presentation,
}: {
  presentation: RecentDatePresentation
}) {
  return (
    <span
      aria-hidden="true"
      data-gap-audit-allow-touch
      className="text-faint @max-recent-rail-collapse:hidden flex flex-col text-xs whitespace-nowrap"
    >
      {presentation.label ? (
        <>
          <span data-recent-date-line>
            <span className="@min-recent-rail-wide:hidden">
              {presentation.compactLabel?.split('\n')[0] ??
                presentation.label.primary}
            </span>
            <span className="@min-recent-rail-wide:inline hidden">
              {presentation.label.primary}
            </span>
          </span>
          {presentation.label.secondary ? (
            <span className="@min-recent-rail-wide:inline hidden">
              {presentation.label.secondary}
            </span>
          ) : null}
          {presentation.compactLabel?.includes('\n') ? (
            <span className="@min-recent-rail-wide:hidden">
              {presentation.compactLabel.split('\n')[1]}
            </span>
          ) : null}
        </>
      ) : null}
    </span>
  )
}
