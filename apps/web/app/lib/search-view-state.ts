/** Navigation metadata only. Never cache titles, snippets or other result bodies. */
export type SearchViewState = {
  depth: number
  expanded: string[]
  groupDepths?: Record<string, number>
  anchor: string
  position: number
  offset: number
}
const entries = new Map<string, SearchViewState>()
export function rememberSearchView(key: string, value: SearchViewState) {
  entries.set(key, value)
}
export function recallSearchView(key: string) {
  return entries.get(key)
}

/**
 * Navigation state for moves the app makes into or within search. It keeps
 * the page the user was on before search, so leaving search (mobile Cancel)
 * returns there instead of stepping back through earlier searches.
 */
export function searchNavigationState(
  from: { pathname: string; search: string; state?: unknown },
  extra: Record<string, unknown> = {},
) {
  const previous = (from.state ?? {}) as { searchReturnTo?: unknown }
  const searchReturnTo =
    from.pathname === '/search'
      ? typeof previous.searchReturnTo === 'string'
        ? previous.searchReturnTo
        : undefined
      : `${from.pathname}${from.search}`
  return { searchFromApp: true, searchReturnTo, ...extra }
}

/** Where leaving search goes: the page before search, else Home. */
export function searchExitPath(state: unknown) {
  const value = (state ?? {}) as { searchReturnTo?: unknown }
  return typeof value.searchReturnTo === 'string' &&
    value.searchReturnTo.startsWith('/') &&
    !value.searchReturnTo.startsWith('//')
    ? value.searchReturnTo
    : '/'
}
