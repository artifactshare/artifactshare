import { searchApiParams } from './search-query'
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
 * The search a history entry showed, so going Back to it continues that
 * search instead of starting a new one. The token is bound to the viewer and
 * expires; it is navigation metadata, not result content.
 */
const searches = new Map<string, { resume: string; actor: string }>()
export function rememberSearch(key: string, resume: string, actor: string) {
  searches.set(key, { resume, actor })
}
// The history entry the browser last moved to with Back or Forward.
let popped: string | undefined
if (typeof window !== 'undefined')
  window.addEventListener('popstate', () => {
    popped = (window.history.state as { key?: string } | null)?.key
  })
/** The search to continue, only when this load comes from Back or Forward. */
function returnedSearch() {
  const key = (window.history.state as { key?: string } | null)?.key
  const wasPopped = popped !== undefined && popped === key
  popped = undefined
  return wasPopped && key ? searches.get(key) : undefined
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

/**
 * Going Back to search results continues the search that entry showed: the
 * same log and no new daily count, with access checked again on the server.
 * Every other load, including a reload, is a new search on the server.
 */
export async function continueReturnedSearch<
  T extends { result: unknown; actor: string },
>(request: Request, serverLoader: () => Promise<T>): Promise<T> {
  const returned = returnedSearch()
  if (!returned) return serverLoader()
  const api = searchApiParams(new URL(request.url).searchParams)
  api.set('resume', returned.resume)
  try {
    const response = await fetch(`/api/search?${api}`, {
      signal: request.signal,
    })
    if (response.ok)
      return {
        result: (await response.json()) as T['result'],
        actor: returned.actor,
      } as T
  } catch (error) {
    if (request.signal.aborted) throw error
  }
  return serverLoader()
}
