import { useSyncExternalStore } from 'react'
import { viewerReturnPath } from '~/lib/viewer-hash'
import { safeInternalNext } from '~/lib/safe-next'

const subscribe = (notify: () => void) => {
  window.addEventListener('hashchange', notify)
  // Accepted frame reports use replaceState, which does not emit hashchange.
  window.addEventListener('artifactshare:hash-changed', notify)
  window.addEventListener('popstate', notify)
  return () => {
    window.removeEventListener('hashchange', notify)
    window.removeEventListener('artifactshare:hash-changed', notify)
    window.removeEventListener('popstate', notify)
  }
}
const snapshot = () => window.location.hash
const serverSnapshot = () => ''

// Hydrated links support normal activation and opening in a new tab.
export function useViewerHash() {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

export function viewerSignInHref(href: string, hash: string) {
  if (!hash) return href
  const url = new URL(href, 'https://example.test')
  if (!url.searchParams.has('next')) return href
  const next = safeInternalNext(url.searchParams.get('next'))
  url.searchParams.set('next', viewerReturnPath(next, hash))
  return href.startsWith('/') ? url.pathname + url.search : url.href
}
