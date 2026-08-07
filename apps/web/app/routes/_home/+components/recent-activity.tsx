import { useMemo } from 'react'
import type { FileRowData } from './file-data'
import {
  fileDateHeadingClassName,
  fileTableListClassName,
} from './file-list-styles'
import { FileRow } from './file-row'
import { AppDividerList } from '~/components/app/app-divider-list'
import { useViewerCalendar } from '~/hooks/use-viewer-calendar'
import { useT } from '~/hooks/use-t'
import { groupByDay } from '~/lib/datetime'

interface RecentActivityProps {
  items: FileRowData[]
  timeZone?: string
  now?: string
}

export function RecentActivity({
  items,
  timeZone: suppliedTimeZone,
  now: suppliedNow,
}: RecentActivityProps) {
  const viewerCalendar = useViewerCalendar()
  const timeZone = suppliedTimeZone ?? viewerCalendar.timeZone
  const now = suppliedNow ?? viewerCalendar.now.toISOString()
  const { locale } = useT()

  const groups = useMemo(
    () =>
      suppliedTimeZone || viewerCalendar.hydrated
        ? groupByDay(
            items,
            (f) => f.modifiedTime ?? '',
            locale,
            new Date(now),
            timeZone,
          )
        : null,
    [items, locale, now, suppliedTimeZone, timeZone, viewerCalendar.hydrated],
  )

  return (
    <AppDividerList className={fileTableListClassName}>
      {groups
        ? groups.map((group) => (
            <div key={group.key}>
              <div className={fileDateHeadingClassName}>
                <h2>{group.heading}</h2>
              </div>
              {group.items.map((file) => (
                <FileRow
                  key={file.id}
                  data={file}
                  showOwner={false}
                  inlineOwner
                  hideMobileVisibility
                  richStats
                  unreadBadges
                  recencyPresentation="grouped-with-preview"
                  now={now}
                />
              ))}
            </div>
          ))
        : items.map((file) => (
            <FileRow
              key={file.id}
              data={file}
              showOwner={false}
              inlineOwner
              hideMobileVisibility
              richStats
              unreadBadges
              recencyPresentation="grouped-with-preview"
              now={now}
            />
          ))}
    </AppDividerList>
  )
}
