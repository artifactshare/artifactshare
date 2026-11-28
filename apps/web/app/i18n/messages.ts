import en from './en.json'
import ja from './ja.json'

export const SUPPORTED_LOCALES = ['en', 'ja'] as const
export type Locale = (typeof SUPPORTED_LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'

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

export type TKey = keyof typeof en

export const MESSAGES: Record<Locale, Record<TKey, string>> = {
  en,
  ja: ja as Record<TKey, string>,
}
