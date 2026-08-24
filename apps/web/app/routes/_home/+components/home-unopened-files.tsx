import { Link, useLocation } from 'react-router'
import type { FileRowData } from './file-data'
import { displayTitle } from '~/lib/display-title'
import { formatDayHeading } from '~/lib/datetime'
import { FileTypeIcon } from '~/components/app/file-type-icon'
import { AppDividerList } from '~/components/app/app-divider-list'
import { AppMoreLink } from '~/components/app/app-more-link'
import { AppSectionHeader } from '~/components/app/app-section-header'
import { useT } from '~/hooks/use-t'
import { useViewerCalendar } from '~/hooks/use-viewer-calendar'
import { currentGalleryReturnTo } from '~/lib/viewer-return'

export function HomeUnopenedFiles({
  files,
  hasMore,
  error,
  now,
}: {
  files: FileRowData[]
  hasMore: boolean
  error: boolean
  now: string
}) {
  const { locale, t } = useT()
  const { hydrated, timeZone } = useViewerCalendar()
  const location = useLocation()

  if (!error && files.length === 0) return null

  const calendarNow = new Date(now)

  return (
    <section
      className="border-divider bg-card mb-8 rounded-md border p-4"
      aria-labelledby="home-unopened-heading"
    >
      <AppSectionHeader
        titleId="home-unopened-heading"
        title={t('home.unopenedTitle')}
        actions={
          hasMore ? (
            <AppMoreLink className="text-xs" to="/files">
              {t('home.unopenedSeeAll')}
            </AppMoreLink>
          ) : null
        }
      />
      <p className="text-muted-foreground mt-1 mb-2 text-xs">
        {t('home.unopenedDescription')}
      </p>
      {error ? (
        <p className="text-muted-foreground text-xs">
          {t('home.unopenedError')}{' '}
          <a href="." className="underline">
            {t('home.reload')}
          </a>
        </p>
      ) : (
        <AppDividerList as="ul" className="divide-y">
          {files.map((file) => {
            const title = displayTitle({
              name: file.fileName,
              derivedTitle: file.derivedTitle,
              titleOverride: file.titleOverride,
            })
            const date =
              hydrated && file.createdTime
                ? formatDayHeading(
                    file.createdTime,
                    locale,
                    calendarNow,
                    timeZone,
                  )
                : ''
            return (
              <li key={file.id}>
                <Link
                  className="group flex min-w-0 items-center gap-2 py-2 text-sm no-underline"
                  to={`/a/${file.id}`}
                  state={{ galleryReturnTo: currentGalleryReturnTo(location) }}
                  viewTransition
                >
                  <FileTypeIcon renderType={file.renderType} size="sm" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium group-hover:underline">
                      {title}
                    </span>
                    <span className="text-muted-foreground flex min-w-0 gap-1 text-xs">
                      {file.projectName ? (
                        <span className="truncate">{file.projectName}</span>
                      ) : null}
                      {file.projectName && date ? (
                        <span aria-hidden="true">·</span>
                      ) : null}
                      {date ? <span className="shrink-0">{date}</span> : null}
                    </span>
                  </span>
                  <span className="text-muted-foreground shrink-0" aria-hidden>
                    →
                  </span>
                </Link>
              </li>
            )
          })}
        </AppDividerList>
      )}
    </section>
  )
}
