/** Navigation metadata only. Never cache titles, snippets or other result bodies. */
export type SearchViewState = {
  depth: number
  expanded: string[]
  groupDepths?: Record<string, number>
  anchor: string
  position: number
  offset: number
  /** The result the user opened last; kept when the scroll anchor moves. */
  opened?: string
}
const entries = new Map<string, SearchViewState>()
export function rememberSearchView(key: string, value: SearchViewState) {
  entries.set(key, value)
}
export function recallSearchView(key: string) {
  return entries.get(key)
}

/**
 * Navigation state for moves the app makes into or within search. It counts
 * the history entries pushed since leaving the page before search, so leaving
 * search (mobile Cancel) can step back to that page with its scroll and state,
 * and keeps that page's path for when the count is unknown.
 */
export function searchNavigationState(
  from: { pathname: string; search: string; state?: unknown },
  extra: Record<string, unknown> = {},
) {
  const previous = (from.state ?? {}) as {
    searchReturnTo?: unknown
    searchDepth?: unknown
  }
  const inSearch = from.pathname === '/search'
  const searchReturnTo = inSearch
    ? typeof previous.searchReturnTo === 'string'
      ? previous.searchReturnTo
      : undefined
    : `${from.pathname}${from.search}`
  const searchDepth = !inSearch
    ? 1
    : typeof previous.searchDepth === 'number'
      ? previous.searchDepth + 1
      : undefined
  return { searchFromApp: true, searchReturnTo, searchDepth, ...extra }
}

/**
 * How to leave search: step back through the counted entries when known,
 * otherwise replace the entry with the page before search, else Home.
 */
export function searchExit(state: unknown): { back: number } | { to: string } {
  const value = (state ?? {}) as {
    searchReturnTo?: unknown
    searchDepth?: unknown
  }
  if (
    typeof value.searchDepth === 'number' &&
    Number.isInteger(value.searchDepth) &&
    value.searchDepth > 0
  )
    return { back: value.searchDepth }
  return {
    to:
      typeof value.searchReturnTo === 'string' &&
      value.searchReturnTo.startsWith('/') &&
      !value.searchReturnTo.startsWith('//')
        ? value.searchReturnTo
        : '/',
  }
}
