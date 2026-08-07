export interface ViewerNavigationState {
  galleryReturnTo?: string
  galleryFocusFallback?: boolean
}

export function currentGalleryReturnTo(location: {
  pathname: string
  search: string
  hash: string
}): string {
  if (location.pathname === '/recent') {
    const params = new URLSearchParams(location.search)
    params.delete('page')
    const search = params.toString()
    return `/recent${search ? `?${search}` : ''}${location.hash}`
  }
  return `${location.pathname}${location.search}${location.hash}`
}

export function hasViewerReturnContext(state: unknown): boolean {
  if (!state || typeof state !== 'object') return false
  const value = (state as ViewerNavigationState).galleryReturnTo
  if (typeof value !== 'string') return false
  return allowedReturnTo(value) !== null
}

export function viewerReturnTo(state: unknown, fallback = '/'): string {
  const fallbackReturnTo = allowedReturnTo(fallback) ?? '/'
  if (!state || typeof state !== 'object') return fallbackReturnTo
  const value = (state as ViewerNavigationState).galleryReturnTo
  if (typeof value !== 'string') return fallbackReturnTo
  return allowedReturnTo(value) ?? fallbackReturnTo
}

function allowedReturnTo(value: string): string | null {
  if (/[\\\t\n\r\f\v]/.test(value)) return null
  let parsed: URL
  try {
    parsed = new URL(value, 'https://artifactshare.invalid')
  } catch {
    return null
  }
  if (parsed.origin !== 'https://artifactshare.invalid') return null
  if (
    parsed.pathname !== '/' &&
    parsed.pathname !== '/recent' &&
    parsed.pathname !== '/files' &&
    !isProjectReturnPath(parsed.pathname)
  ) {
    return null
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`
}

function isProjectReturnPath(pathname: string): boolean {
  return /^\/projects\/[^/]+$/.test(pathname)
}

export function viewerReturnState(): ViewerNavigationState {
  return { galleryFocusFallback: true }
}

export function shouldFocusGalleryFallback(state: unknown): boolean {
  return (
    !!state &&
    typeof state === 'object' &&
    (state as ViewerNavigationState).galleryFocusFallback === true
  )
}
