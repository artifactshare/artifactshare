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
