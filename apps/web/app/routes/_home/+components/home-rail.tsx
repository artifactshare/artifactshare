import { Link } from 'react-router'
import { IconEye, IconMessage, IconStack2 as Layers } from '@tabler/icons-react'
import type { FileRowData } from './file-data'
import type { RailProject } from '~/services/home.server'
import { displayTitle } from '~/lib/display-title'
import { formatDayHeading, TODAY, YESTERDAY } from '~/lib/datetime'
import { versionBadgeLabel } from '~/lib/version-badge'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { FileTypeIcon } from '~/components/app/file-type-icon'
import { useT } from '~/hooks/use-t'
import { fileHasUnread, unreadNewCommentLabel } from './unread-motion'
import { useViewerCalendar } from '~/hooks/use-viewer-calendar'
import { AppDividerList } from '~/components/app/app-divider-list'
import { AppMoreLink } from '~/components/app/app-more-link'
import { AppSectionHeader } from '~/components/app/app-section-header'

const EMPTY_RECENT: FileRowData[] = []

// レール行の数値: 閲覧は常時、コメントは 1 件以上のときだけ (企画 §3 項 8)。
// コメント数はモバイル幅で落としてよいが閲覧数は落とさない (§4)
function RailCounts({ data }: { data: FileRowData }) {
  const { tPlural } = useT()
  return (
    <span className="text-muted-foreground inline-flex shrink-0 items-center gap-2 text-xs">
      <span
        className="inline-flex items-center gap-0.5"
        aria-label={tPlural('card.viewCount', data.viewCount)}
      >
        <IconEye size={12} aria-hidden="true" />
        {data.viewCount}
      </span>
      {data.commentCount > 0 ? (
        <span
          className="max-phone:hidden inline-flex items-center gap-0.5"
          aria-label={tPlural('card.commentCount', data.commentCount)}
        >
          <IconMessage size={12} aria-hidden="true" />
          {data.commentCount}
        </span>
      ) : null}
    </span>
  )
}

export function HomeRail({
  files,
  recent = EMPTY_RECENT,
  projects,
  errors,
  now,
  variant = 'default',
}: {
  files: FileRowData[]
  recent?: FileRowData[]
  projects: RailProject[]
  errors: { files: boolean; recent?: boolean; projects: boolean }
  now?: string
  variant?: 'default' | 'without-recent'
}) {
  const { locale, t, tPlural } = useT()
  const { hydrated, timeZone } = useViewerCalendar()
  const calendarNow = new Date(now ?? new Date().toISOString())

  const railError = (
    <p className="text-muted-foreground text-xs">
      {t('home.railError')}{' '}
      <a href="." className="underline">
        {t('home.reload')}
      </a>
    </p>
  )

  const head = (title: string, href: string) => (
    <AppSectionHeader
      title={title}
      actions={
        <AppMoreLink className="text-xs" to={href}>
          {t('home.seeAll')}
        </AppMoreLink>
      }
    />
  )

  const viewedLabel = (iso: string) => {
    const day = formatDayHeading(iso, locale, calendarNow, timeZone)
    if (day === TODAY[locale]) return t('rail.viewedToday')
    if (day === YESTERDAY[locale]) return t('rail.viewedYesterday')
    return t('rail.viewedOn', { day })
  }

  const updatedLabel = (iso: string) => {
    const day = formatDayHeading(iso, locale, calendarNow, timeZone)
    if (day === TODAY[locale]) return t('rail.updatedToday')
    if (day === YESTERDAY[locale]) return t('rail.updatedYesterday')
    return t('rail.updatedOn', { day })
  }

  return (
    <aside className="flex min-w-0 flex-col gap-8">
      <section>
        {head(t('home.myFiles'), '/files')}
        {errors.files ? (
          railError
        ) : files.length ? (
          <AppDividerList as="ul" className="divide-y">
            {files.map((f) => (
              <li
                key={f.id}
                className="flex min-w-0 items-center gap-2 py-2 text-sm"
              >
                <FileTypeIcon renderType={f.renderType} size="sm" />
                <span className="min-w-0 flex-1">
                  <Link
                    className="block truncate font-medium hover:underline"
                    to={`/a/${f.id}`}
                  >
                    {displayTitle({
                      name: f.fileName,
                      derivedTitle: f.derivedTitle,
                      titleOverride: f.titleOverride,
                    })}
                  </Link>
                  <span className="text-muted-foreground text-xs">
                    {f.createdTime
                      ? hydrated
                        ? formatDayHeading(
                            f.createdTime,
                            locale,
                            calendarNow,
                            timeZone,
                          )
                        : ''
                      : '—'}
                  </span>
                </span>
                <RailCounts data={f} />
              </li>
            ))}
          </AppDividerList>
        ) : (
          <p className="text-muted-foreground text-xs">{t('home.noFiles')}</p>
        )}
      </section>
      <section>
        {head(t('home.projects'), '/projects')}
        {errors.projects ? (
          railError
        ) : projects.length ? (
          <AppDividerList as="ul" className="divide-y">
            {projects.map((p) => (
              <li key={p.id} className="min-w-0 py-2 text-sm">
                {p.joined ? (
                  <Link
                    className="flex min-w-0 items-center gap-2 hover:underline"
                    to={`/projects/${p.id}`}
                  >
                    <Layers
                      size={14}
                      className="text-link flex-none"
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {p.name}
                    </span>
                    {(p.newCount ?? 0) > 0 ? (
                      <span className="bg-link-soft text-link shrink-0 rounded-full px-2 py-0.5 text-xs font-medium">
                        {t('project.newBadge', {
                          count:
                            (p.newCount ?? 0) > 99 ? '99+' : String(p.newCount),
                        })}
                      </span>
                    ) : null}
                  </Link>
                ) : (
                  <Link
                    className="truncate hover:underline"
                    to={`/projects/${p.id}`}
                  >
                    {p.name}
                  </Link>
                )}
                {p.joined ? (
                  <span className="text-muted-foreground block text-xs">
                    {tPlural('tb.fileCount', p.fileCount ?? 0)}
                    {p.updatedAt && hydrated
                      ? ` · ${updatedLabel(p.updatedAt)}`
                      : ''}
                  </span>
                ) : null}
              </li>
            ))}
          </AppDividerList>
        ) : (
          <p className="text-muted-foreground text-xs">
            {t('home.noProjects')}
          </p>
        )}
      </section>
      {variant === 'default' ? (
        <section>
          {head(t('home.recentViewed'), '/recent')}
          {errors.recent ? (
            railError
          ) : recent.length ? (
            <AppDividerList as="ul" className="divide-y">
              {recent.map((f) => {
                const title = displayTitle({
                  name: f.fileName,
                  derivedTitle: f.derivedTitle,
                  titleOverride: f.titleOverride,
                })
                const versionMotionLabel =
                  now != null
                    ? versionBadgeLabel(f, now, (version) =>
                        t('project.versionBadge', { version: version }),
                      )
                    : null
                const unreadCommentLabel = unreadNewCommentLabel(
                  f.unreadCommentCount ?? 0,
                  t,
                  tPlural,
                )
                const unread = fileHasUnread(f)
                const linkLabel = unread
                  ? `${title} · ${t('row.unread')}`
                  : title
                return (
                  <li
                    key={f.id}
                    className="flex min-w-0 items-center gap-2 py-2 text-sm"
                  >
                    {unread ? (
                      <span
                        className="bg-link size-2 shrink-0 rounded-full"
                        aria-hidden="true"
                      />
                    ) : null}
                    <FileTypeIcon renderType={f.renderType} size="sm" />
                    <span className="min-w-0 flex-1">
                      <Link
                        className="block truncate font-medium hover:underline"
                        to={`/a/${f.id}`}
                        aria-label={linkLabel}
                      >
                        {title}
                      </Link>
                      <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1 text-xs">
                        <AuthorAvatar
                          id={f.ownerId}
                          image={f.ownerImage}
                          initial={f.ownerInitial}
                          size="xs"
                        />
                        <span className="min-w-0 truncate">
                          {f.ownerName ?? f.ownerEmail ?? '—'}
                        </span>
                        {versionMotionLabel ? (
                          <span className="shrink-0">
                            · {versionMotionLabel}
                          </span>
                        ) : null}
                        {unreadCommentLabel ? (
                          <span className="shrink-0">
                            · {unreadCommentLabel}
                          </span>
                        ) : null}
                        {f.modifiedTime && hydrated ? (
                          <span className="shrink-0">
                            · {viewedLabel(f.modifiedTime)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <RailCounts data={f} />
                  </li>
                )
              })}
            </AppDividerList>
          ) : (
            <p className="text-muted-foreground text-xs">
              {t('home.noRecent')}
            </p>
          )}
        </section>
      ) : null}
    </aside>
  )
}
