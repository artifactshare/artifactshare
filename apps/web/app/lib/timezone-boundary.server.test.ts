import { describe, expect, test } from 'vitest'
import { localDayKeyFromTimezone } from './datetime'
import { timezoneDayUtcRange } from './timezone-boundary.server'

const durationHours = (start: string, end: string) =>
  (Date.parse(end) - Date.parse(start)) / 3_600_000

describe('timezoneDayUtcRange', () => {
  test('produces a 23-hour New York day at the spring DST transition', () => {
    const range = timezoneDayUtcRange('2026-03-08', 'America/New_York')

    expect(durationHours(range.start, range.end)).toBe(23)
    expect(localDayKeyFromTimezone(range.start, 'America/New_York')).toBe(
      '2026-03-08',
    )
    expect(
      localDayKeyFromTimezone(
        new Date(Date.parse(range.end) - 1).toISOString(),
        'America/New_York',
      ),
    ).toBe('2026-03-08')
  })

  test('produces a 25-hour New York day at the autumn DST transition', () => {
    const range = timezoneDayUtcRange('2026-11-01', 'America/New_York')

    expect(durationHours(range.start, range.end)).toBe(25)
  })

  test('keeps consecutive ranges continuous across a DST transition', () => {
    const first = timezoneDayUtcRange('2026-03-08', 'America/New_York')
    const next = timezoneDayUtcRange('2026-03-09', 'America/New_York')

    expect(first.end).toBe(next.start)
  })

  test('uses the first valid instant when local midnight does not exist', () => {
    const previous = timezoneDayUtcRange('2026-09-05', 'America/Santiago')
    const range = timezoneDayUtcRange('2026-09-06', 'America/Santiago')
    const next = timezoneDayUtcRange('2026-09-07', 'America/Santiago')

    expect(previous.end).toBe(range.start)
    expect(range.end).toBe(next.start)
    expect(durationHours(range.start, range.end)).toBe(23)
    expect(localDayKeyFromTimezone(range.start, 'America/Santiago')).toBe(
      '2026-09-06',
    )
  })

  test('serializes boundaries in the fixed-width storage format', () => {
    const range = timezoneDayUtcRange('2026-07-30', 'Asia/Tokyo')

    expect(range).toEqual({
      start: '2026-07-29T15:00:00.000Z',
      end: '2026-07-30T15:00:00.000Z',
    })
    expect('2026-07-29T15:00:00.000Z' >= range.start).toBe(true)
    expect('2026-07-30T15:00:00.000Z' < range.end).toBe(false)
  })
})
