import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'
import {
  isMasterPublicPagePath,
  publicPagePathLocale,
} from '~/lib/public-pages'

const JA_PREFIX = '/ja/'

const UPDATES_DETAIL_PATH = /^\/(?:ja\/)?updates\/([a-z0-9-]+)$/

export function normalizeGuidePathname(pathname: string): string {
  return pathname === '/' ? pathname : pathname.replace(/\/+$/, '')
}

export function getUpdatesDetailSlug(pathname: string): string | null {
  const match = UPDATES_DETAIL_PATH.exec(normalizeGuidePathname(pathname))
  return match?.[1] ?? null
}

export function isPublicPagePath(pathname: string): boolean {
  const normalized = normalizeGuidePathname(pathname)
  return (
    isMasterPublicPagePath(normalized) ||
    getUpdatesDetailSlug(normalized) !== null
  )
}

export function pathGuideLocale(pathname: string): Locale | null {
  const normalized = normalizeGuidePathname(pathname)
  if (
    isMasterPublicPagePath(normalized) ||
    getUpdatesDetailSlug(normalized) !== null
  ) {
    return (
      publicPagePathLocale(normalized) ??
      (normalized.startsWith(JA_PREFIX) ? 'ja' : DEFAULT_LOCALE)
    )
  }
  return null
}
