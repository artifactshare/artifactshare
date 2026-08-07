export function withoutUploadQuery(url: URL): string {
  const searchParams = new URLSearchParams(url.search)
  searchParams.delete('upload')
  const search = searchParams.toString()
  return `${url.pathname}${search ? `?${search}` : ''}${url.hash}`
}

export function hasUploadQuery(search: string): boolean {
  return new URLSearchParams(search).get('upload') === '1'
}

export function uploadReturnTo(location: {
  pathname: string
  search: string
  hash: string
}): string {
  return withoutUploadQuery(
    new URL(
      `${location.pathname}${location.search}${location.hash}`,
      'https://artifactshare.local',
    ),
  )
}
