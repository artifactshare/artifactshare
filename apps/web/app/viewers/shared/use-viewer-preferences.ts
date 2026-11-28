import { useEffect, useSyncExternalStore } from 'react'
import type { PreferencesStore } from './preferences-store'
import type { ViewerPreferences } from './preferences'

export function useViewerPreferences(
  preferences: PreferencesStore,
): ViewerPreferences {
  const current = useSyncExternalStore(
    preferences.subscribe,
    preferences.getSnapshot,
  )
  const { locale, theme } = current
  useEffect(() => {
    document.documentElement.lang = locale
    document.documentElement.dataset.theme = theme
  }, [locale, theme])
  return current
}
