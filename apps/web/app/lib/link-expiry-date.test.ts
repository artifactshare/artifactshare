import { describe, expect, test } from 'vitest'
import {
  addDaysToLocalDate,
  clampLocalDateToMaximum,
  localDateEndAsUtc,
  maximumSelectableLocalDate,
  toLocalDateInputValue,
} from './link-expiry-date'

describe('link expiry date conversion', () => {
  test('stores the selected local date through its final millisecond', () => {
    const result = localDateEndAsUtc('2026-08-18')
    const local = new Date(result!)
    expect([
      local.getFullYear(),
      local.getMonth() + 1,
      local.getDate(),
      local.getHours(),
      local.getMinutes(),
      local.getSeconds(),
      local.getMilliseconds(),
    ]).toEqual([2026, 8, 18, 23, 59, 59, 999])
  })

  test('renders a UTC timestamp as the viewer local date', () => {
    const timestamp = new Date(2026, 7, 18, 23, 59, 59, 999).toISOString()
    expect(toLocalDateInputValue(timestamp)).toBe('2026-08-18')
  })

  test('adds policy days using local calendar boundaries', () => {
    expect(addDaysToLocalDate(1, new Date(2026, 6, 31, 22))).toBe('2026-08-01')
  })

  test('keeps the displayed maximum date inside the exact duration limit', () => {
    const now = new Date(2026, 6, 20, 12)
    const selected = maximumSelectableLocalDate(90, now)
    const expiry = localDateEndAsUtc(selected)!
    expect(Date.parse(expiry)).toBeLessThanOrEqual(
      now.getTime() + 90 * 24 * 60 * 60 * 1000,
    )
    expect(maximumSelectableLocalDate(1, now)).toBe('2026-07-20')
  })

  test('clamps a policy default to the last selectable date', () => {
    expect(clampLocalDateToMaximum('2026-10-18', '2026-10-17')).toBe(
      '2026-10-17',
    )
    expect(clampLocalDateToMaximum('2026-10-16', '2026-10-17')).toBe(
      '2026-10-16',
    )
  })

  test('rejects malformed and impossible dates', () => {
    expect(localDateEndAsUtc('2026-02-30')).toBeNull()
    expect(localDateEndAsUtc('not-a-date')).toBeNull()
  })
})
