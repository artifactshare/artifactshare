import en from './en.json'
import ja from './ja.json'

export const SUPPORTED_LOCALES = ['en', 'ja'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

/**
 * Display label for each locale in the locale switcher. Endonyms — every
 * locale shows in its own language so users can recognize their option
 * regardless of current setting. Adding a locale to SUPPORTED_LOCALES
 * without a label here is a compile error.
 */
export const LOCALE_LABEL = {
  en: 'English',
  ja: '日本語',
} satisfies Record<Locale, string>

export function isSupportedLocale(value: unknown): value is Locale {
  return (
    typeof value === 'string' &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  )
}

/** All translation keys (derived from the canonical English catalog). */
export type TKey = keyof typeof en

/** Catalog by locale. EN is the source of truth for keys; JA must match. */
export const MESSAGES: Record<Locale, Record<TKey, string>> = {
  en,
  ja: ja as Record<TKey, string>,
}
