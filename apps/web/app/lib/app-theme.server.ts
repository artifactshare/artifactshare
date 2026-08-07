import { readCookie, serializeCookie } from './cookies.server'
import { DEFAULT_APP_THEME, isAppTheme, type AppTheme } from './app-theme'

const APP_THEME_COOKIE = '__as_theme'

export function getAppTheme(request: Request): AppTheme {
  const value = readCookie(request, APP_THEME_COOKIE)
  return isAppTheme(value) ? value : DEFAULT_APP_THEME
}

export function appThemeCookieHeader(theme: AppTheme): string {
  return serializeCookie(APP_THEME_COOKIE, theme, {
    maxAgeSeconds: 31536000,
  })
}
