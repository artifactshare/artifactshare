/*
 * Storage convention: all timestamp columns are TEXT in ISO 8601 with `Z`
 * suffix. ISO 8601+Z is lexicographically sortable, so plain string `<`/`>`
 * in Kysely queries is safe and matches temporal order.
 */

import type { Locale } from '~/i18n/messages'

const DEFAULT_TIME_ZONE = 'UTC'

export function nowIso(): string {
  return new Date().toISOString()
}

// ISO timestamp `ms` milliseconds in the past — for "within the last N" window
// queries (e.g. idempotency / dedup lookups).
export function isoMsAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY
const MONTH = 30 * DAY
const YEAR = 365 * DAY

// Intl constructors allocate ICU lookup tables — heavy. Pre-build one per
// supported locale at module load (unrolled so the no-hoist-intl lint rule
// sees explicit module-scope construction). `satisfies` makes adding a new
// supported locale a compile error here.
const RTF_EN = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const RTF_JA = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' })
const RTF = {
  en: RTF_EN,
  ja: RTF_JA,
} satisfies Record<Locale, Intl.RelativeTimeFormat>

const dayFormatterCache = new Map<string, Intl.DateTimeFormat>()
const dayKeyFormatterCache = new Map<string, Intl.DateTimeFormat>()

function dayFormatter(locale: Locale, includeYear: boolean, timeZone: string) {
  const key = `${locale}:${includeYear ? 'year' : 'day'}:${timeZone}`
  let formatter = dayFormatterCache.get(key)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      locale,
      locale === 'ja'
        ? {
            ...(includeYear ? { year: 'numeric' as const } : {}),
            month: 'numeric',
            day: 'numeric',
            weekday: 'short',
            timeZone,
          }
        : {
            ...(includeYear ? { year: 'numeric' as const } : {}),
            month: 'short',
            day: 'numeric',
            timeZone,
          },
    )
    dayFormatterCache.set(key, formatter)
  }
  return formatter
}

export const TODAY = {
  en: 'Today',
  ja: '今日',
} satisfies Record<Locale, string>

export const YESTERDAY = {
  en: 'Yesterday',
  ja: '昨日',
} satisfies Record<Locale, string>

function localDayKey(d: Date, timeZone = DEFAULT_TIME_ZONE): string {
  let formatter = dayKeyFormatterCache.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
    dayKeyFormatterCache.set(timeZone, formatter)
  }
  const parts = formatter.formatToParts(d)
  return `${partValue(parts, 'year')}-${partValue(parts, 'month')}-${partValue(parts, 'day')}`
}

function previousLocalDayKey(at: Date, timeZone = DEFAULT_TIME_ZONE): string {
  const key = localDayKey(at, timeZone)
  const d = new Date(`${key}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

export function dayBucketKey(
  iso: string,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return localDayKey(d, timeZone)
}

function partValue(
  parts: Intl.DateTimeFormatPart[],
  type: Intl.DateTimeFormatPartTypes,
): string {
  return parts.find((p) => p.type === type)?.value ?? ''
}

function jaDayHeading(
  date: Date,
  includeYear: boolean,
  timeZone: string,
): string {
  const dtf = dayFormatter('ja', includeYear, timeZone)
  const parts = dtf.formatToParts(date)
  const month = partValue(parts, 'month')
  const day = partValue(parts, 'day')
  const weekday = partValue(parts, 'weekday')
  if (includeYear) {
    const year = partValue(parts, 'year')
    return `${year}年${month}月${day}日(${weekday})`
  }
  return `${month}月${day}日(${weekday})`
}

export function formatDayHeading(
  iso: string,
  locale: Locale,
  at: Date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const key = dayBucketKey(iso, timeZone)
  if (key === localDayKey(at, timeZone)) return TODAY[locale]
  if (key === previousLocalDayKey(at, timeZone)) return YESTERDAY[locale]

  const includeYear = key.slice(0, 4) !== localDayKey(at, timeZone).slice(0, 4)
  if (locale === 'ja') return jaDayHeading(date, includeYear, timeZone)
  return dayFormatter(locale, includeYear, timeZone).format(date)
}

export function groupByDay<T>(
  items: readonly T[],
  getIso: (item: T) => string,
  locale: Locale,
  at: Date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): { key: string; heading: string; items: T[] }[] {
  const groups: { key: string; heading: string; items: T[] }[] = []
  for (const item of items) {
    const iso = getIso(item)
    const key = dayBucketKey(iso, timeZone)
    const last = groups.at(-1)
    if (last?.key === key) {
      last.items.push(item)
    } else {
      groups.push({
        key,
        heading: formatDayHeading(iso, locale, at, timeZone),
        items: [item],
      })
    }
  }
  return groups
}

export function localDayKeyFromTimezone(iso: string, timeZone: string): string {
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return ''
  return localDayKey(new Date(t), timeZone)
}

function formatDayHeadingFromKey(
  dayKey: string,
  locale: Locale,
  at: Date,
  timeZone = DEFAULT_TIME_ZONE,
): string {
  if (!dayKey) return ''
  const [ys, ms, ds] = dayKey.split('-')
  const y = Number(ys)
  const m = Number(ms)
  const d = Number(ds)
  if (
    !ys ||
    !ms ||
    !ds ||
    Number.isNaN(y) ||
    Number.isNaN(m) ||
    Number.isNaN(d)
  ) {
    return ''
  }

  if (dayKey === localDayKey(at, timeZone)) return TODAY[locale]
  if (dayKey === previousLocalDayKey(at, timeZone)) return YESTERDAY[locale]

  const date = new Date(Date.UTC(y, m - 1, d))
  const includeYear = ys !== localDayKey(at, timeZone).slice(0, 4)
  if (locale === 'ja') return jaDayHeading(date, includeYear, 'UTC')
  return dayFormatter(locale, includeYear, 'UTC').format(date)
}

export function groupByDayKey<T>(
  items: readonly T[],
  getDayKey: (item: T) => string,
  locale: Locale,
  at: Date = new Date(),
  timeZone = DEFAULT_TIME_ZONE,
): { key: string; heading: string; items: T[] }[] {
  const groups: { key: string; heading: string; items: T[] }[] = []
  for (const item of items) {
    const key = getDayKey(item)
    const last = groups.at(-1)
    if (last?.key === key) {
      last.items.push(item)
    } else {
      groups.push({
        key,
        heading: formatDayHeadingFromKey(key, locale, at, timeZone),
        items: [item],
      })
    }
  }
  return groups
}

export function formatRelative(
  iso: string,
  locale: Locale,
  at: Date = new Date(),
): string {
  const diffMs = new Date(iso).getTime() - at.getTime()
  const absMs = Math.abs(diffMs)
  const rtf = RTF[locale]

  if (absMs < MINUTE) return rtf.format(0, 'second')
  if (absMs < HOUR) return rtf.format(Math.round(diffMs / MINUTE), 'minute')
  if (absMs < DAY) return rtf.format(Math.round(diffMs / HOUR), 'hour')
  if (absMs < WEEK) return rtf.format(Math.round(diffMs / DAY), 'day')
  if (absMs < MONTH) return rtf.format(Math.round(diffMs / WEEK), 'week')
  if (absMs < YEAR) return rtf.format(Math.round(diffMs / MONTH), 'month')
  return rtf.format(Math.round(diffMs / YEAR), 'year')
}
