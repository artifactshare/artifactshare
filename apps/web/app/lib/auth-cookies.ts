export const AUTH_SESSION_TOKEN_COOKIE_NAMES = [
  '__Secure-better-auth.session_token',
  'better-auth.session_token',
] as const

export const AUTH_SESSION_DATA_COOKIE_NAMES = [
  '__Secure-better-auth.session_data',
  'better-auth.session_data',
] as const

const AUTH_COOKIE_NAMES = [
  ...AUTH_SESSION_TOKEN_COOKIE_NAMES,
  ...AUTH_SESSION_DATA_COOKIE_NAMES,
] as const

const AUTH_COOKIE_NAME_SET = new Set<string>(AUTH_COOKIE_NAMES)

export function isAuthCookieName(name: string): boolean {
  if (AUTH_COOKIE_NAME_SET.has(name)) return true
  return AUTH_SESSION_DATA_COOKIE_NAMES.some((dataName) =>
    name.startsWith(`${dataName}.`),
  )
}

// better-auth lastLoginMethod plugin writes the last-used sign-in method here
// (not httpOnly, 30-day). The secure-prefixed form is read too in case a
// production deploy prefixes it like the session cookie.
const LAST_LOGIN_METHOD_COOKIE_NAMES = new Set<string>([
  'better-auth.last_used_login_method',
  '__Secure-better-auth.last_used_login_method',
])

/** Read the last-used login method ('google' | 'microsoft' | 'email' | …) from a Cookie header. */
export function readLastLoginMethod(
  cookieHeader: string | null,
): string | null {
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.split('=')
    const name = rawName?.trim()
    if (name && LAST_LOGIN_METHOD_COOKIE_NAMES.has(name)) {
      // The cookie is client-controlled (not httpOnly); a malformed percent
      // escape would otherwise throw and 500 the whole root loader.
      try {
        return decodeURIComponent(rawValue.join('=').trim()) || null
      } catch {
        return null
      }
    }
  }
  return null
}
