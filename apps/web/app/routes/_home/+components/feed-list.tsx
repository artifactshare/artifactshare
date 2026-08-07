import { useMemo } from 'react'
import type { FeedEventRow } from '~/services/events.server'
import { FeedItem } from './feed-item'
import { useHydrated } from '~/hooks/use-hydrated'
import { useT } from '~/hooks/use-t'
import { groupByDayKey } from '~/lib/datetime'

const feedDayGroupClassName = 'mt-3.5'
export const feedDayHeadingClassName =
  'text-faint mb-1 px-1 text-xs font-semibold'

export function FeedList({
  rows,
  timeZone,
  now,
  showLocation,
  headingAs = 'h2',
}: {
  rows: FeedEventRow[]
  timeZone: string
  now: string
  showLocation?: boolean
  headingAs?: 'h2' | 'h3'
}) {
  const hydrated = useHydrated()
  const { locale } = useT()

  const groups = useMemo(
    () =>
      hydrated
        ? groupByDayKey(
            rows,
            (row) => row.dayKey,
            locale,
            new Date(now),
            timeZone,
          )
        : null,
    [rows, locale, hydrated, now, timeZone],
  )

  if (rows.length === 0) return null

  const Heading = headingAs

  if (!groups) {
    return (
      <ul>
        {rows.map((row) => (
          <FeedItem key={row.id} row={row} showLocation={showLocation} />
        ))}
      </ul>
    )
  }

  return (
    <div>
      {groups.map((group) => (
        <section key={group.key} className={feedDayGroupClassName}>
          <Heading className={feedDayHeadingClassName}>{group.heading}</Heading>
          <ul>
            {group.items.map((row) => (
              <FeedItem key={row.id} row={row} showLocation={showLocation} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
