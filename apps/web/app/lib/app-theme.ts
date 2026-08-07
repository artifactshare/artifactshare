const APP_THEMES = ['system', 'light', 'dark'] as const

export type AppTheme = (typeof APP_THEMES)[number]

export const DEFAULT_APP_THEME: AppTheme = 'system'

export function isAppTheme(value: unknown): value is AppTheme {
  return value === 'system' || value === 'light' || value === 'dark'
}
