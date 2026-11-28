export function openSearchField(query: string) {
  window.dispatchEvent(new CustomEvent('search:edit', { detail: query }))
}
