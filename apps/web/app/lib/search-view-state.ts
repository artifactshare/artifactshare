import { searchApiParams } from './search-query'
export type SearchViewState = {
  depth: number
  expanded: string[]
  groupDepths?: Record<string, number>
  anchor: string
  position: number
  offset: number
  opened?: string
}
const entries = new Map<string, SearchViewState>()
export function rememberSearchView(key: string, value: SearchViewState) {
  entries.set(key, value)
}
export function recallSearchView(key: string) {
  return entries.get(key)
}

const searches = new Map<string, { resume: string; actor: string }>()
export function rememberSearch(key: string, resume: string, actor: string) {
  searches.set(key, { resume, actor })
}
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

let shown: string | undefined
export function showSearch(key: string) {
  shown = key
  return () => {
    if (shown === key) shown = undefined
  }
}
function returnedSearch(url: URL) {
  // React Router reads an entry without a stored key as "default".
  const key =
    (window.history.state as { key?: string } | null)?.key ?? 'default'
  if (key === shown) return undefined
  if (
    url.pathname + url.search !==
    window.location.pathname + window.location.search
  )
    return undefined
  return searches.get(key)
}

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
    if (response.status === 401) return serverLoader()
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
