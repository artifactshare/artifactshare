import { describe, expect, test } from 'vitest'
import {
  dayBucketKey,
  formatDayHeading,
  formatRelative,
  groupByDay,
  groupByDayKey,
  localDayKeyFromTimezone,
  nowIso,
  isUtcZTimestamp,
  recentDatePresentation,
  relativeDayKind,
} from './datetime'

const at = new Date('2026-05-11T00:00:00.000Z')
const iso = (offsetMs: number) =>
  new Date(at.getTime() + offsetMs).toISOString()

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function utcIso(year: number, month: number, day: number, hour = 12): string {
  return new Date(Date.UTC(year, month - 1, day, hour, 0, 0)).toISOString()
}

const dayAt = new Date('2026-06-15T09:00:00.000Z')

describe('nowIso', () => {
  test('returns an ISO 8601 UTC string with Z suffix', () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  })
})

describe('Home recent date presentation', () => {
  const now = new Date('2026-08-16T03:00:00.000Z')

  test('accepts only the persisted UTC Z timestamp contract', () => {
    expect(isUtcZTimestamp('2026-08-16T03:00:00.000Z')).toBe(true)
    expect(isUtcZTimestamp('2026-08-16T03:00:00Z')).toBe(true)
    expect(isUtcZTimestamp('2026-08-16T12:00:00+09:00')).toBe(false)
    expect(isUtcZTimestamp('2026-08-16T03:00:00.000z')).toBe(false)
    expect(isUtcZTimestamp('not-a-date')).toBe(false)
  })

  test('prioritizes yesterday across a year boundary', () => {
    expect(
      relativeDayKind('2025-12-31', new Date('2026-01-01T12:00:00Z')),
    ).toBe('yesterday')
  })

  test('formats wide, compact, and full labels in Japanese and English', () => {
    expect(recentDatePresentation('2026-08-16', 'ja', now)).toEqual({
      label: { primary: '今日', secondary: '8/16(日)' },
      compactLabel: '今日',
      fullDate: '2026年8月16日',
    })
    expect(recentDatePresentation('2026-08-15', 'en', now)).toEqual({
      label: { primary: 'Yesterday', secondary: 'Sat, Aug 15' },
      compactLabel: 'Yest.',
      fullDate: 'August 15, 2026',
    })
    expect(recentDatePresentation('2026-08-14', 'ja', now)?.label.primary).toBe(
      '8/14(金)',
    )
    expect(recentDatePresentation('2026-08-14', 'en', now)?.label.primary).toBe(
      'Fri, Aug 14',
    )
    expect(recentDatePresentation('2025-12-31', 'en', now)).toMatchObject({
      label: { primary: '2025', secondary: 'Wed, Dec 31' },
      compactLabel: '25\n12/31',
    })
  })
})

describe('formatRelative — en', () => {
  test('< 1min → now', () => {
    expect(formatRelative(iso(-30_000), 'en', at)).toBe('now')
  })

  test('past minute', () => {
    expect(formatRelative(iso(-2 * MIN), 'en', at)).toBe('2 minutes ago')
  })

  test('past hour', () => {
    expect(formatRelative(iso(-3 * HOUR), 'en', at)).toBe('3 hours ago')
  })

  test('past day', () => {
    expect(formatRelative(iso(-1 * DAY), 'en', at)).toBe('yesterday')
    expect(formatRelative(iso(-5 * DAY), 'en', at)).toBe('5 days ago')
  })

  test('future', () => {
    expect(formatRelative(iso(+1 * DAY), 'en', at)).toBe('tomorrow')
    expect(formatRelative(iso(+2 * HOUR), 'en', at)).toBe('in 2 hours')
  })

  test('year boundary', () => {
    expect(formatRelative(iso(-400 * DAY), 'en', at)).toBe('last year')
  })
})

describe('formatRelative — ja', () => {
  test('past hour in Japanese', () => {
    expect(formatRelative(iso(-2 * HOUR), 'ja', at)).toBe('2 時間前')
  })

  test('yesterday in Japanese', () => {
    expect(formatRelative(iso(-1 * DAY), 'ja', at)).toBe('昨日')
  })
})

describe('dayBucketKey', () => {
  test('returns the calendar day in the requested timezone', () => {
    expect(dayBucketKey('2026-06-14T15:00:00.000Z', 'Asia/Tokyo')).toBe(
      '2026-06-15',
    )
  })

  test('returns empty string for invalid ISO input', () => {
    expect(dayBucketKey('')).toBe('')
  })
})

describe('formatDayHeading', () => {
  test('same local day as at → Today / 今日', () => {
    expect(formatDayHeading(utcIso(2026, 6, 15), 'en', dayAt, 'UTC')).toBe(
      'Today',
    )
    expect(formatDayHeading(utcIso(2026, 6, 15), 'ja', dayAt, 'UTC')).toBe(
      '今日',
    )
  })

  test('previous local day → Yesterday / 昨日', () => {
    expect(formatDayHeading(utcIso(2026, 6, 14), 'en', dayAt, 'UTC')).toBe(
      'Yesterday',
    )
    expect(formatDayHeading(utcIso(2026, 6, 14), 'ja', dayAt, 'UTC')).toBe(
      '昨日',
    )
  })

  test('earlier same year → date label without year', () => {
    expect(formatDayHeading(utcIso(2026, 6, 10), 'en', dayAt, 'UTC')).toBe(
      'Jun 10',
    )
    expect(formatDayHeading(utcIso(2026, 6, 10), 'ja', dayAt, 'UTC')).toBe(
      '6月10日(水)',
    )
  })

  test('different year → date label with year', () => {
    expect(formatDayHeading(utcIso(2025, 12, 31), 'en', dayAt, 'UTC')).toBe(
      'Dec 31, 2025',
    )
    expect(formatDayHeading(utcIso(2025, 12, 31), 'ja', dayAt, 'UTC')).toBe(
      '2025年12月31日(水)',
    )
  })
})

describe('groupByDay', () => {
  type Item = { id: string; updatedAt: string }

  test('groups descending items by the requested calendar day', () => {
    const items: Item[] = [
      { id: 'a', updatedAt: utcIso(2026, 6, 15, 10) },
      { id: 'b', updatedAt: utcIso(2026, 6, 15, 8) },
      { id: 'c', updatedAt: utcIso(2026, 6, 14, 20) },
      { id: 'd', updatedAt: utcIso(2026, 6, 10, 12) },
    ]

    const groups = groupByDay(
      items,
      (item) => item.updatedAt,
      'en',
      dayAt,
      'UTC',
    )

    expect(groups).toHaveLength(3)
    expect(groups[0]).toMatchObject({
      key: '2026-06-15',
      heading: 'Today',
      items: [items[0], items[1]],
    })
    expect(groups[1]).toMatchObject({
      key: '2026-06-14',
      heading: 'Yesterday',
      items: [items[2]],
    })
    expect(groups[2]).toMatchObject({
      key: '2026-06-10',
      heading: 'Jun 10',
      items: [items[3]],
    })
  })

  test('preserves input order within each group', () => {
    const items: Item[] = [
      { id: 'first', updatedAt: utcIso(2026, 6, 15, 18) },
      { id: 'second', updatedAt: utcIso(2026, 6, 15, 9) },
    ]

    const groups = groupByDay(
      items,
      (item) => item.updatedAt,
      'ja',
      dayAt,
      'UTC',
    )

    expect(groups[0].items.map((item) => item.id)).toEqual(['first', 'second'])
    expect(groups[0].heading).toBe('今日')
  })
})

describe('localDayKeyFromTimezone', () => {
  test('UTC uses the UTC calendar day', () => {
    expect(localDayKeyFromTimezone('2026-07-30T00:00:00.000Z', 'UTC')).toBe(
      '2026-07-30',
    )
    expect(localDayKeyFromTimezone('2026-07-30T23:59:59.999Z', 'UTC')).toBe(
      '2026-07-30',
    )
  })

  test('Asia/Tokyo shifts the day boundary to 15:00Z', () => {
    expect(
      localDayKeyFromTimezone('2026-07-29T15:00:00.000Z', 'Asia/Tokyo'),
    ).toBe('2026-07-30')
    expect(
      localDayKeyFromTimezone('2026-07-30T14:59:59.999Z', 'Asia/Tokyo'),
    ).toBe('2026-07-30')
    expect(
      localDayKeyFromTimezone('2026-07-30T15:00:00.000Z', 'Asia/Tokyo'),
    ).toBe('2026-07-31')
  })

  test('America/New_York follows summer and winter DST boundaries', () => {
    expect(
      localDayKeyFromTimezone('2026-07-30T03:59:59.999Z', 'America/New_York'),
    ).toBe('2026-07-29')
    expect(
      localDayKeyFromTimezone('2026-07-30T04:00:00.000Z', 'America/New_York'),
    ).toBe('2026-07-30')
    expect(
      localDayKeyFromTimezone('2026-01-30T04:59:59.999Z', 'America/New_York'),
    ).toBe('2026-01-29')
    expect(
      localDayKeyFromTimezone('2026-01-30T05:00:00.000Z', 'America/New_York'),
    ).toBe('2026-01-30')
  })

  test('Asia/Kolkata shifts the day boundary to 18:30Z', () => {
    expect(
      localDayKeyFromTimezone('2026-07-29T18:30:00.000Z', 'Asia/Kolkata'),
    ).toBe('2026-07-30')
    expect(
      localDayKeyFromTimezone('2026-07-30T18:29:59.999Z', 'Asia/Kolkata'),
    ).toBe('2026-07-30')
    expect(
      localDayKeyFromTimezone('2026-07-30T18:30:00.000Z', 'Asia/Kolkata'),
    ).toBe('2026-07-31')
  })

  test('Asia/Kathmandu shifts the day boundary to 18:15Z', () => {
    expect(
      localDayKeyFromTimezone('2026-07-29T18:15:00.000Z', 'Asia/Kathmandu'),
    ).toBe('2026-07-30')
    expect(
      localDayKeyFromTimezone('2026-07-30T18:14:59.999Z', 'Asia/Kathmandu'),
    ).toBe('2026-07-30')
    expect(
      localDayKeyFromTimezone('2026-07-30T18:15:00.000Z', 'Asia/Kathmandu'),
    ).toBe('2026-07-31')
  })

  test('returns empty string for invalid ISO input', () => {
    expect(localDayKeyFromTimezone('', 'UTC')).toBe('')
    expect(localDayKeyFromTimezone('not-a-date', 'Asia/Tokyo')).toBe('')
  })
})

describe('groupByDayKey', () => {
  type Item = { id: string; dayKey: string }

  // 見出しはキーの年月日そのものから組む。`new Date('2026-07-30')` は UTC 深夜
  // として解釈されるため、その経路を通ると UTC より西の TZ で 1 日前になる。
  // ただしその退行は west-of-UTC でしか現れず、JST でも CI (UTC) でも同じ結果に
  // なるので、このテストで捕まえられるのは「キーと違う日付が出る」実装だけ。
  test('builds the heading from the key parts', () => {
    const groupAt = new Date(2026, 0, 15, 12, 0, 0)
    const items: Item[] = [{ id: 'a', dayKey: '2026-07-30' }]

    const groups = groupByDayKey(items, (item) => item.dayKey, 'ja', groupAt)

    expect(groups[0].key).toBe('2026-07-30')
    expect(groups[0].heading).toBe('7月30日(木)')
  })

  test('headings match Today, Yesterday, same-year, and year-boundary labels', () => {
    const items: Item[] = [
      { id: 'today', dayKey: '2026-06-15' },
      { id: 'yesterday', dayKey: '2026-06-14' },
      { id: 'same-year', dayKey: '2026-06-10' },
      { id: 'prior-year', dayKey: '2025-12-31' },
    ]

    const groups = groupByDayKey(items, (item) => item.dayKey, 'ja', dayAt)

    expect(groups).toHaveLength(4)
    expect(groups[0].heading).toBe('今日')
    expect(groups[1].heading).toBe('昨日')
    expect(groups[2].heading).toBe('6月10日(水)')
    expect(groups[3].heading).toBe('2025年12月31日(水)')
  })

  test('merges adjacent items with the same day key', () => {
    const groupAt = new Date(2026, 0, 15, 12, 0, 0)
    const items: Item[] = [
      { id: 'a', dayKey: '2026-07-30' },
      { id: 'b', dayKey: '2026-07-30' },
      { id: 'c', dayKey: '2026-07-29' },
    ]

    const groups = groupByDayKey(items, (item) => item.dayKey, 'en', groupAt)

    expect(groups).toHaveLength(2)
    expect(groups[0].items.map((item) => item.id)).toEqual(['a', 'b'])
    expect(groups[1].items.map((item) => item.id)).toEqual(['c'])
  })
})
