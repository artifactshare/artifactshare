// Comment locations on static sites: the served file or route pathname, plus
// the fragment only when it is a hash route (`#/…` or `#!/…`). Every other
// fragment is an in-page anchor and is not part of the location. The rule
// reads the URL only, never the DOM, so a saved location cannot change after
// posting. Shared by the injected reporter, the viewer and the server.
//
// The pathname is stored decoded, as delivery resolves it (root and
// single-segment index aliases, NFC). Route fragments are stored with each
// slash-delimited segment decoded once and re-encoded with encodeURIComponent;
// a route query keeps its literal `?`, `&`, `=` and `+` separators.

export const MAX_COMMENT_LOCATION_LENGTH = 1000

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** A decoded pathname in the form delivery serves, or null when unservable. */
export function canonicalCommentPathname(decoded: string): string | null {
  if (typeof decoded !== 'string' || decoded[0] !== '/') return null
  if (decoded.startsWith('//') || decoded.startsWith('/\\')) return null
  if (hasControlCharacter(decoded) || /[#?]/.test(decoded)) return null
  try {
    // Throws for unpaired surrogates, which no URL can carry.
    encodeURIComponent(decoded)
  } catch {
    return null
  }
  const rawPath = decoded === '/' ? '/index.html' : decoded
  const parts = rawPath.replaceAll('\\', '/').split('/')
  if (parts.includes('..')) return null
  // Delivery refuses these extensions (see the bundle path validator).
  if (/\.(?:exe|sh|php|py|rb|bat|cmd|dll|so)$/i.test(rawPath)) return null
  const segments = parts.filter((segment) => segment !== '' && segment !== '.')
  if (segments.length === 0) return '/index.html'
  if (segments.length === 1) {
    const lower = segments[0].toLowerCase()
    if (lower === 'index.html' || lower === 'index.md') segments[0] = lower
  }
  return `/${segments.join('/')}`.normalize('NFC')
}

/** Decodes once and re-encodes, or null for malformed or unencodable text. */
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

/** Recodes each piece between literal separators, keeping the separators. */
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

/**
 * The canonical route fragment, '' for in-page (native) fragments, or null
 * for a route fragment with a malformed percent escape or unencodable text.
 * A literal `?` starts the route's query, whose `&`, `=` and `+` stay literal,
 * so reopening the location gives the router the same path and query.
 */
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

/** The location for a browser URL's pathname (encoded) and hash. */
export function commentLocationFromUrl(
  pathname: string,
  hash: string,
): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const path = canonicalCommentPathname(decoded)
  const route = canonicalCommentRouteHash(hash)
  if (path === null || route === null) return null
  const location = path + route
  return location.length <= MAX_COMMENT_LOCATION_LENGTH ? location : null
}

/** Splits a stored or posted location into its canonical parts. */
export function parseCommentLocation(
  location: unknown,
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
  )
  const hash = canonicalCommentRouteHash(
    hashIndex === -1 ? '' : location.slice(hashIndex),
  )
  if (pathname === null || hash === null) return null
  return { pathname, hash, location: pathname + hash }
}

/** The in-frame URL path (pathname plus route hash) that opens a location. */
export function commentLocationHref(location: string): string | null {
  const parsed = parseCommentLocation(location)
  if (!parsed) return null
  const pathname = parsed.pathname
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return pathname + parsed.hash
}

export function hasCommentPathExtension(pathname: string): boolean {
  const lastSegment = pathname.split('/').at(-1) ?? ''
  return /\.[^./]+$/.test(lastSegment)
}

/** A location is served by a version file or, with fallback, by its index. */
export function isCommentLocationServed(
  location: string,
  files: { has(path: string): boolean },
  fallbackToIndex: boolean,
): boolean {
  const parsed = parseCommentLocation(location)
  if (!parsed || parsed.location !== location) return false
  return (
    files.has(parsed.pathname) ||
    (fallbackToIndex &&
      files.has('/index.html') &&
      !hasCommentPathExtension(parsed.pathname))
  )
}
