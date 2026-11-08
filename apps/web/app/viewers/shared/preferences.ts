// Relative imports: the viewers' browser test fixtures load this protocol in
// Node.
import { isAppTheme, type AppTheme } from '../../lib/app-theme'
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  type Locale,
} from '../../i18n/messages'

// Display preferences the app hands to a common viewer (PDF or video) in its
// sandbox frame.
// They are presentation only: no token, no access decision and no reporter
// state rides on them, so the viewer accepts them from its parent window
// alone and ignores anything malformed.
export type ViewerPreferences = { locale: Locale; theme: AppTheme }

export const DEFAULT_VIEWER_PREFERENCES: ViewerPreferences = {
  locale: DEFAULT_LOCALE,
  theme: 'system',
}

const SOURCE = 'artifactshare-parent'
const KIND = 'viewer-preferences'

export function viewerPreferencesMessage(preferences: ViewerPreferences) {
  return {
    source: SOURCE,
    kind: KIND,
    locale: preferences.locale,
    theme: preferences.theme,
  } as const
}

export function parseViewerPreferencesMessage(
  data: unknown,
): ViewerPreferences | null {
  if (!data || typeof data !== 'object') return null
  const message = data as Record<string, unknown>
  if (message.source !== SOURCE || message.kind !== KIND) return null
  if (!isSupportedLocale(message.locale) || !isAppTheme(message.theme))
    return null
  return { locale: message.locale, theme: message.theme }
}
