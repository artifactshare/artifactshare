import { useMemo } from 'react'
import { Link, useFetcher } from 'react-router'
import { IconDots, IconStack2 } from '@tabler/icons-react'
import type { FeedEventRow } from '~/services/events.server'
import type { listProjectPins } from '~/services/project-pins.server'
import type { listProjectViewRanking } from '~/services/events.server'
import type { FileRowData } from '../../_home/+components/file-data'
import { FileRow } from '../../_home/+components/file-row'
import {
  FileRowDialogs,
  useFileRowActions,
} from '../../_home/+components/file-row-dialogs'
import { BulkBar } from '../../_home/+components/bulk-bar'
import { useBulkActions } from '../../_home/+hooks/use-bulk-actions'
import { ShareablePeek } from '~/components/app/peek-card'
import { FeedItem } from '../../_home/+components/feed-item'
import { fileTableListClassName } from '../../_home/+components/file-list-styles'
import { FileTypeIcon } from '~/components/app/file-type-icon'
import { renderTypeFromKind } from '~/lib/artifact-type'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { IconButton } from '~/components/app/icon-button'
import { Button } from '~/components/ui/button'
import { AppEmptyState } from '~/components/app/app-empty-state'
import { AppSectionHeader } from '~/components/app/app-section-header'
import { AppDividerList } from '~/components/app/app-divider-list'
import { AppMoreLink } from '~/components/app/app-more-link'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { displayTitle } from '~/lib/display-title'
import { formatRelative, groupByDay } from '~/lib/datetime'
import { useViewerCalendar } from '~/hooks/use-viewer-calendar'
import { useT } from '~/hooks/use-t'
import {
  redesignSectionClassName,
  redesignPinGridClassName,
  redesignPinCardClassName,
  redesignColumnsClassName,
  redesignRankRowClassName,
} from './project-redesign-styles'

import { versionBadgeLabel } from '~/lib/version-badge'

const RECENT_FILES_LIMIT = 10

type Pins = Awaited<ReturnType<typeof listProjectPins>>
type Ranking = Awaited<ReturnType<typeof listProjectViewRanking>>

export function ProjectRedesignBody({
  projectId,
  files,
  pins,
  feed,
  ranking,
  now,
  canPin,
  canUpload,
  archived,
  onUpload,
  homeOwnerName,
}: {
  projectId: string
  files: FileRowData[]
  pins: Pins
  feed: FeedEventRow[] | null
  ranking: Ranking
  now: string
  canPin: boolean
  canUpload: boolean
  archived: boolean
  onUpload: () => void
  homeOwnerName: string
}) {
  const { t, locale } = useT()
  const { hydrated, timeZone, now: calendarNow } = useViewerCalendar()
  const fetcher = useFetcher()
  const rowActions = useFileRowActions()
  const bulk = useBulkActions(files.map((f) => f.id))
  const pin = (intent: 'pin' | 'unpin', shareableId: string) =>
    fetcher.submit({ intent, shareableId }, { method: 'post' })
  const pinnedIds = useMemo(
    () => new Set(pins.map((p) => p.shareableId)),
    [pins],
  )
  const sortedFiles = useMemo(
    () =>
      files.toSorted(
        (a, b) =>
          (b.createdTime ?? '').localeCompare(a.createdTime ?? '') ||
          b.id.localeCompare(a.id),
      ),
    [files],
  )
  const recentFiles = sortedFiles.slice(0, RECENT_FILES_LIMIT)
  const groups = hydrated
    ? groupByDay(
        recentFiles,
        (f) => f.createdTime ?? '',
        locale,
        calendarNow,
        timeZone,
      )
    : [{ key: '', heading: '', items: recentFiles }]
  const remaining = sortedFiles.length - recentFiles.length

  if (sortedFiles.length === 0) {
    return (
      <AppEmptyState
        icon={<IconStack2 size={16} />}
        title={t('project.noFilesTitle')}
        body={
          archived ? t('project.archivedNoFilesBody') : t('project.noFilesBody')
        }
        action={
          archived || !canUpload ? null : (
            <Button type="button" size="sm" onClick={onUpload}>
              {t('tb.addFile')}
            </Button>
          )
        }
      />
    )
  }

  const showPinActions = canPin && !archived
  return (
    <>
      <FileRowDialogs active={rowActions.active} onClose={rowActions.close} />
      <BulkBar bulk={bulk} files={files} homeOwnerName={homeOwnerName} />
      {pins.length > 0 ? (
        <section className={redesignSectionClassName}>
          <AppSectionHeader
            title={t('project.pinned')}
            meta={t('project.pinnedDescription')}
          />
          <div className={redesignPinGridClassName}>
            {pins.map((pinned) => {
              const title = displayTitle({
                name: pinned.name,
                derivedTitle: pinned.derivedTitle,
                titleOverride: pinned.titleOverride,
              })
              return (
                <div
                  key={pinned.shareableId}
                  className={redesignPinCardClassName}
                >
                  <div className="flex items-start justify-between gap-2">
                    <ShareablePeek id={pinned.shareableId}>
                      <Link
                        className="text-foreground line-clamp-2 min-w-0 font-medium hover:underline"
                        to={`/a/${pinned.shareableId}`}
                      >
                        {title}
                      </Link>
                    </ShareablePeek>
                    {showPinActions ? (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <IconButton
                            type="button"
                            icon={IconDots}
                            size="sm"
                            aria-label={t('project.pinMenu')}
                          />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => pin('unpin', pinned.shareableId)}
                          >
                            {t('project.unpin')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    ) : null}
                  </div>
                  <div className="text-muted-foreground mt-2 flex items-center gap-1.5 text-xs">
                    {pinned.latestAuthorName || pinned.latestAuthorEmail ? (
                      <AuthorAvatar
                        id={pinned.latestAuthorEmail ?? pinned.shareableId}
                        image={pinned.latestAuthorImage}
                        initial={
                          (pinned.latestAuthorName ??
                            pinned.latestAuthorEmail ??
                            '')[0]
                        }
                        size="xs"
                      />
                    ) : null}
                    {pinned.latestVersionNumber >= 2 ? (
                      <span>v{pinned.latestVersionNumber}</span>
                    ) : null}
                    {pinned.latestPublishedAt ? (
                      <span>
                        {t('project.fileUpdated', {
                          time: formatRelative(
                            pinned.latestPublishedAt,
                            locale,
                          ),
                        })}
                      </span>
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      ) : null}
      <div className={redesignColumnsClassName}>
        <section>
          <AppSectionHeader
            title={t('project.recentFiles')}
            meta={t('project.createdOrder')}
          />
          {groups.map((group, index) => (
            <div key={`${group.key}-${index}`}>
              {group.heading ? (
                <AppSectionHeader
                  as="h3"
                  title={group.heading}
                  variant="group"
                />
              ) : null}
              <AppDividerList className={fileTableListClassName}>
                {group.items.map((file) => (
                  <FileRow
                    key={file.id}
                    data={file}
                    variant="project"
                    versionBadge={versionBadgeLabel(file, now, (version) =>
                      t('project.versionBadge', { version }),
                    )}
                    menuEnabled
                    peekEnabled
                    onAction={(action) => rowActions.open(action, file)}
                    onPinToggle={
                      showPinActions
                        ? () =>
                            pin(
                              pinnedIds.has(file.id) ? 'unpin' : 'pin',
                              file.id,
                            )
                        : undefined
                    }
                    pinned={pinnedIds.has(file.id)}
                    selectable
                    selected={bulk.selected.includes(file.id)}
                    onToggleSelect={() => bulk.toggle(file.id)}
                  />
                ))}
              </AppDividerList>
            </div>
          ))}
          {remaining > 0 ? (
            <AppMoreLink
              className="mt-3 inline-block"
              to={`/projects/${projectId}/files`}
            >
              {t('project.moreFiles', { count: remaining })}
            </AppMoreLink>
          ) : null}
        </section>
        <aside>
          {feed !== null ? (
            <section>
              <AppSectionHeader title={t('project.activity')} />
              {feed.length > 0 ? (
                <>
                  <ul className="m-0 list-none p-0">
                    {feed.map((row) => (
                      <FeedItem key={row.id} row={row} compact />
                    ))}
                  </ul>
                  <AppMoreLink
                    className="mt-3 inline-block"
                    to={`/projects/${projectId}/activity`}
                  >
                    {t('project.activityHistoryLink')}
                  </AppMoreLink>
                </>
              ) : (
                <AppEmptyState
                  className="p-0"
                  title={t('project.noActivity')}
                />
              )}
            </section>
          ) : null}
          {ranking.length > 0 ? (
            <section className={redesignSectionClassName}>
              <AppSectionHeader
                title={t('project.mostViewed')}
                meta={t('project.last30Days')}
              />
              {ranking.map((row) => {
                const renderType = renderTypeFromKind(row.artifactKind)
                return (
                  <Link
                    key={row.shareableId}
                    className={redesignRankRowClassName}
                    to={`/a/${row.shareableId}`}
                  >
                    <FileTypeIcon renderType={renderType} size="sm" />
                    <span className="min-w-0 flex-1 truncate">
                      {displayTitle({
                        name: row.name,
                        derivedTitle: row.derivedTitle,
                        titleOverride: row.titleOverride,
                      })}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t('project.viewCountTimes', { count: row.viewCount })}
                    </span>
                  </Link>
                )
              })}
            </section>
          ) : null}
        </aside>
      </div>
    </>
  )
}
