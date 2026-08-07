// Server-side cookie helpers shared by UI-preference routes (locale, view mode).
// Cookies are host-only (no Domain attr) so they never reach the sandbox subdomain.

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie')
  if (!header) return null
  const prefix = `${name}=`
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    if (trimmed.startsWith(prefix)) {
      try {
        return decodeURIComponent(trimmed.slice(prefix.length))
      } catch {
        return null
      }
    }
  }
  return null
}

interface CookieOptions {
  maxAgeSeconds: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: 'Lax' | 'Strict' | 'None'
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieOptions,
): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${options.maxAgeSeconds}`,
    `SameSite=${options.sameSite ?? 'Lax'}`,
    ...(options.httpOnly ? ['HttpOnly'] : []),
    ...((options.secure ?? true) ? ['Secure'] : []),
  ].join('; ')
}
