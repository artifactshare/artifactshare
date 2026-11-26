// Results guidance edits the owning header input without changing conditions.
export function openSearchField(query: string) {
  window.dispatchEvent(new CustomEvent('search:edit', { detail: query }))
}
