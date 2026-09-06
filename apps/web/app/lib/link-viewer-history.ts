export function linkViewerHistoryUrl(
  pathname: string,
  search: string,
  hash: string,
): string {
  const params = new URLSearchParams(search)
  params.delete('version')
  const query = params.toString()
  return `${pathname}${query ? `?${query}` : ''}${hash}`
}
