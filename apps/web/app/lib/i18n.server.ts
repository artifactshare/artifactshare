/*
 * Server-only locale resolution.
 * Priority: user.locale → __as_locale cookie → Accept-Language → 'en'.
 * user.locale wins when present; cookie is the unauthenticated / fallback path.
 */

import { DEFAULT_LOCALE, isSupportedLocale, type Locale } from '~/i18n/messages'
import { readCookie, serializeCookie } from './cookies.server'

export { isSupportedLocale }

const LOCALE_COOKIE = '__as_locale'

/**
 * Reduce a BCP 47 tag (`'ja'`, `'en-US'`, `'pt-BR'`) to a supported `Locale`,
 * or null if no match. Used by sign-in (Google `locale` claim) and by
 * `Accept-Language` parsing.
 */
export function normalizeLocaleTag(
  input: string | null | undefined,
): Locale | null {
  if (!input) return null
  const base = input.toLowerCase().split('-')[0]
  return isSupportedLocale(base) ? base : null
}

/** Resolve locale for a request. Pass user.locale if signed in. */
export function getLocale(
  request: Request,
  userLocale?: string | null,
): Locale {
  if (isSupportedLocale(userLocale)) return userLocale

  const cookieValue = readCookie(request, LOCALE_COOKIE)
  if (isSupportedLocale(cookieValue)) return cookieValue

  const header = request.headers.get('accept-language')
  if (header) {
    for (const tag of parseAcceptLanguage(header)) {
      const normalized = normalizeLocaleTag(tag)
      if (normalized) return normalized
    }
  }

  return DEFAULT_LOCALE
}

/** Build a Set-Cookie header that pins the locale (1 year, host-only). */
export function localeCookieHeader(locale: Locale): string {
  return serializeCookie(LOCALE_COOKIE, locale, { maxAgeSeconds: 31536000 })
}

/** Parse Accept-Language into tags ordered by q. */
function parseAcceptLanguage(header: string): string[] {
  const parsed: { tag: string; q: number }[] = []
  for (const entry of header.split(',')) {
    const [rawTag, ...params] = entry.trim().split(';')
    const tag = rawTag.trim()
    if (!tag) continue
    let q = 1
    for (const p of params) {
      const match = p.trim().match(/^q=([\d.]+)$/i)
      if (match) q = Number.parseFloat(match[1])
    }
    parsed.push({ tag, q })
  }
  return parsed.sort((a, b) => b.q - a.q).map((x) => x.tag)
}
