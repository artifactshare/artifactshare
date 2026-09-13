import { DEFAULT_LOCALE, type Locale } from '~/i18n/messages'

export function resolvePublicRouteLocale(locale: string | undefined): Locale {
  if (locale === undefined) return DEFAULT_LOCALE
  if (locale === 'ja') return locale
  throw new Response('Not Found', { status: 404 })
}
