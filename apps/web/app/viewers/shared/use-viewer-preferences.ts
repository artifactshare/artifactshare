import { useEffect, useSyncExternalStore } from 'react'
import type { PreferencesStore } from './preferences-store'
import type { ViewerPreferences } from './preferences'

// The viewer's UI follows the app's language and theme: the current
// preferences, also applied to the viewer document's root so the stylesheet
// (data-theme) and assistive technology (lang) follow them.
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
