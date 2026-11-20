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

// The history entry whose search results are on screen, if any. A load for
// a different remembered entry is a return to it with Back or Forward: a new
// search, even for the same words, starts from the entry on screen, because
// the browser adds the new entry only after the load.
let shown: string | undefined
export function showSearch(key: string) {
  shown = key
  return () => {
    if (shown === key) shown = undefined
  }
}
function returnedSearch(url: URL) {
  const key = (window.history.state as { key?: string } | null)?.key
  if (!key || key === shown) return undefined
  if (
    url.pathname + url.search !==
    window.location.pathname + window.location.search
  )
    return undefined
  return searches.get(key)
}

/**
 * Going Back to search results continues the search that entry showed: the
 * same log and no new daily count, with access checked again on the server.
 * Every other load, including a reload, is a new search on the server.
 */
export async function continueReturnedSearch<
  T extends { result: unknown; actor: string },
>(request: Request, serverLoader: () => Promise<T>): Promise<T> {
  const url = new URL(request.url)
  const returned = returnedSearch(url)
  if (!returned) return serverLoader()
  const api = searchApiParams(url.searchParams)
  api.set('resume', returned.resume)
  try {
    const response = await fetch(`/api/search?${api}`, {
      signal: request.signal,
    })
    // Signing in again is the server loader's job.
    if (response.status === 401) return serverLoader()
    // Any other failure is shown as the page's error, never retried as a
    // second, counted search.
    const payload = (
      response.ok
        ? await response.json()
        : ((await response.json().catch(() => null)) ?? {
            error: { code: 'search_failed' },
          })
    ) as { actor?: string }
    const { actor, ...body } = payload
    return {
      result: body as T['result'],
      actor: actor ?? returned.actor,
    } as T
  } catch (error) {
    if (request.signal.aborted) throw error
  }
  return serverLoader()
}
