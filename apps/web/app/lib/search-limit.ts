import type { Locale } from '~/i18n/messages'

export const SEARCH_DAILY_LIMIT = 'search_daily_limit_exceeded'
export type SearchLimitResponse = {
  error: { code: string; retry_at: string; message?: string }
}
export class SearchRequestError extends Error {
  readonly retryAt?: string
  constructor(error: { code: string; retry_at?: string }) {
    super(error.code)
    this.retryAt =
      error.code === SEARCH_DAILY_LIMIT ? error.retry_at : undefined
  }
}
// An explicit zone keeps server rendering and hydration identical.
const options = {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'short',
} as const
const formatters = {
  en: new Intl.DateTimeFormat('en', options),
  ja: new Intl.DateTimeFormat('ja', options),
}
export function searchResetTime(retryAt: string, locale: Locale) {
  return formatters[locale].format(new Date(retryAt))
}
