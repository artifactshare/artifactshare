import { useSyncExternalStore } from 'react'
import { useDocumentAttribute } from '~/hooks/use-document-attribute'
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
  useDocumentAttribute('lang', locale)
  useDocumentAttribute('data-theme', theme)
  return current
}
