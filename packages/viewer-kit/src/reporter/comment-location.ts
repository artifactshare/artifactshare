import { staticSitePathCandidates } from './static-site-paths.js'

export const MAX_COMMENT_LOCATION_LENGTH = 1000

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export function canonicalCommentPathname(
  decoded: string,
  fallbackToIndex = false,
): string | null {
  if (typeof decoded !== 'string' || decoded[0] !== '/') return null
  if (decoded.startsWith('//') || decoded.startsWith('/\\')) return null
  if (hasControlCharacter(decoded) || /[#?]/.test(decoded)) return null
  try {
    // Throws for unpaired surrogates, which no URL can carry.
    encodeURIComponent(decoded)
  } catch {
    return null
  }
  const parts = decoded.replaceAll('\\', '/').split('/')
  if (parts.includes('..')) return null
  if (/\.(?:exe|sh|php|py|rb|bat|cmd|dll|so)$/i.test(decoded)) return null
  const segments = parts.filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return fallbackToIndex ? '/' : '/index.html'
  if (segments.length === 1) {
    const lower = segments[0].toLowerCase()
    if (lower === 'index.html' || lower === 'index.md') segments[0] = lower
  }
  return `/${segments.join('/')}`.normalize('NFC')
}

function recodeComponent(component: string): string | null {
  try {
    const decoded = decodeURIComponent(component)
    if (hasControlCharacter(decoded)) return null
    // Throws for unpaired surrogates, which no URL can carry.
    return encodeURIComponent(decoded)
  } catch {
    return null
  }
}

function recodeJoined(value: string, separators: string): string | null {
  if (!separators) return recodeComponent(value)
  const parts: string[] = []
  for (const part of value.split(separators[0])) {
    const recoded = recodeJoined(part, separators.slice(1))
    if (recoded === null) return null
    parts.push(recoded)
  }
  return parts.join(separators[0])
}

export function canonicalCommentRouteHash(hash: string): string | null {
  if (typeof hash !== 'string') return null
  const prefix = hash.startsWith('#/')
    ? '#/'
    : hash.startsWith('#!/')
      ? '#!/'
      : ''
  if (!prefix) return ''
  const route = hash.slice(prefix.length)
  const queryIndex = route.indexOf('?')
  const path = recodeJoined(
    queryIndex === -1 ? route : route.slice(0, queryIndex),
    '/',
  )
  if (path === null) return null
  if (queryIndex === -1) return prefix + path
  const query = recodeJoined(route.slice(queryIndex + 1), '&=+')
  return query === null ? null : `${prefix}${path}?${query}`
}

export function commentLocationFromUrl(
  pathname: string,
  hash: string,
  fallbackToIndex = false,
): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const path = canonicalCommentPathname(decoded, fallbackToIndex)
  const route = canonicalCommentRouteHash(hash)
  if (path === null || route === null) return null
  const location = path + route
  return location.length <= MAX_COMMENT_LOCATION_LENGTH ? location : null
}

export function parseCommentLocation(
  location: unknown,
  fallbackToIndex = false,
): { pathname: string; hash: string; location: string } | null {
  if (
    typeof location !== 'string' ||
    !location ||
    location.length > MAX_COMMENT_LOCATION_LENGTH
  )
    return null
  const hashIndex = location.indexOf('#')
  const pathname = canonicalCommentPathname(
    hashIndex === -1 ? location : location.slice(0, hashIndex),
    fallbackToIndex,
  )
  const hash = canonicalCommentRouteHash(
    hashIndex === -1 ? '' : location.slice(hashIndex),
  )
  if (pathname === null || hash === null) return null
  return { pathname, hash, location: pathname + hash }
}

export function commentLocationHref(
  location: string,
  fallbackToIndex = false,
): string | null {
  const parsed = parseCommentLocation(location, fallbackToIndex)
  if (!parsed) return null
  const pathname = parsed.pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return pathname + parsed.hash
}

export function isCommentLocationServed(
  location: string,
  files: { has(path: string): boolean },
  fallbackToIndex: boolean,
): boolean {
  const parsed = parseCommentLocation(location, fallbackToIndex)
  if (!parsed || parsed.location !== location) return false
  const { direct, fallback } = staticSitePathCandidates(parsed.pathname)
  return (
    direct.some((path) => files.has(path)) ||
    (fallbackToIndex && fallback !== null && files.has(fallback))
  )
}
