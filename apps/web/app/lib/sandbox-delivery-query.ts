export function withoutSearchParameters(
  search: string,
  names: readonly string[],
): string {
  if (!search) return ''
  const excluded = new Set(names)
  const parts = search
    .slice(1)
    .split('&')
    .filter((part) => {
      const name = new URLSearchParams(part).keys().next().value
      return name === undefined || !excluded.has(name)
    })
  return parts.length ? `?${parts.join('&')}` : ''
}
