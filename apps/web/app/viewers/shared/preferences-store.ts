import {
  DEFAULT_VIEWER_PREFERENCES,
  parseViewerPreferencesMessage,
  type ViewerPreferences,
} from './preferences'

export function createPreferencesStore(view: Window = window) {
  let preferences: ViewerPreferences = {
    ...DEFAULT_VIEWER_PREFERENCES,
    locale: /^ja\b/i.test(view.navigator.language || '')
      ? 'ja'
      : DEFAULT_VIEWER_PREFERENCES.locale,
  }
  const listeners = new Set<() => void>()
  view.addEventListener('message', (event) => {
    if (view.parent === view || event.source !== view.parent) return
    const next = parseViewerPreferencesMessage(event.data)
    if (
      !next ||
      (next.locale === preferences.locale && next.theme === preferences.theme)
    )
      return
    preferences = next
    for (const listener of listeners) listener()
  })
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => preferences,
  }
}

export type PreferencesStore = ReturnType<typeof createPreferencesStore>
