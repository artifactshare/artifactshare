import {
  DEFAULT_VIEWER_PREFERENCES,
  parseViewerPreferencesMessage,
  type ViewerPreferences,
} from './preferences'

// Holds the app's display preferences for this viewer document. It listens
// from the moment the viewer script runs, before React renders, so a message
// the parent sends when the frame loads is never missed. Until one arrives,
// or when the viewer is not framed, the app defaults apply.
export function createPreferencesStore(view: Window = window) {
  let preferences: ViewerPreferences = DEFAULT_VIEWER_PREFERENCES
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
