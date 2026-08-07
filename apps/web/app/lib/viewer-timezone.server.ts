import { readCookie } from './cookies.server'

const TZ_COOKIE = '__as_tz'
export const DEFAULT_VIEWER_TIMEZONE = 'UTC'
const TIMEZONE_CACHE_LIMIT = 128
const canonicalTimezones = new Map<string, string | null>()

export function canonicalViewerTimezone(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const cached = canonicalTimezones.get(value)
  if (cached !== undefined) return cached
  try {
    const canonical = Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).resolvedOptions().timeZone
    rememberCanonicalTimezone(value, canonical)
    return canonical
  } catch {
    rememberCanonicalTimezone(value, null)
    return null
  }
}

function rememberCanonicalTimezone(
  value: string,
  canonical: string | null,
): void {
  if (canonicalTimezones.size >= TIMEZONE_CACHE_LIMIT) {
    canonicalTimezones.clear()
  }
  canonicalTimezones.set(value, canonical)
}

export function getViewerTimezone(request: Request): string {
  const cookieValue = readCookie(request, TZ_COOKIE)
  return canonicalViewerTimezone(cookieValue) ?? DEFAULT_VIEWER_TIMEZONE
}
