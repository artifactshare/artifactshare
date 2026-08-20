import type { AnalyticsAuthMethod } from './events'

export const AUTH_ATTEMPT_COOKIE = '__as_auth_attempt'
const AUTH_ATTEMPT_TAB_KEY = '__as_auth_attempt_nonce'
const AUTH_ATTEMPT_MAX_AGE_SECONDS = 1800
const MAX_AUTH_ATTEMPTS = 4

export interface AuthAttempt {
  method: AnalyticsAuthMethod
  artifactId?: string
  authCompletedSent: boolean
  accountState?: 'new' | 'existing'
  nonce: string
}

function readCookie(): string | null {
  if (typeof document === 'undefined') return null
  const prefix = `${AUTH_ATTEMPT_COOKIE}=`
  const raw = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix))
  if (!raw) return null
  try {
    return decodeURIComponent(raw.slice(prefix.length))
  } catch {
    return null
  }
}

function validAttempt(value: Partial<AuthAttempt>): value is AuthAttempt {
  if (!['google', 'microsoft', 'email'].includes(value.method ?? ''))
    return false
  if (value.artifactId !== undefined && typeof value.artifactId !== 'string')
    return false
  if (typeof value.authCompletedSent !== 'boolean') return false
  if (
    value.accountState !== undefined &&
    !['new', 'existing'].includes(value.accountState)
  )
    return false
  return Boolean(value.nonce && typeof value.nonce === 'string')
}

function readAuthAttempts(): AuthAttempt[] {
  const raw = readCookie()
  if (!raw) return []
  try {
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.filter((attempt): attempt is AuthAttempt =>
      validAttempt(attempt as Partial<AuthAttempt>),
    )
  } catch {
    return []
  }
}

export function readAuthAttempt(
  recoveryArtifactId?: string,
): AuthAttempt | null {
  const attempts = readAuthAttempts()
  const tabNonce = sessionStorage.getItem(AUTH_ATTEMPT_TAB_KEY)
  if (tabNonce) return attempts.find(({ nonce }) => nonce === tabNonce) ?? null
  // Mobile browsers may discard sessionStorage while an OAuth tab is
  // backgrounded. A sole pending attempt is still unambiguous; multiple
  // candidates fail closed rather than attributing the wrong method/artifact.
  if (
    attempts.length === 1 &&
    recoveryArtifactId !== undefined &&
    attempts[0].artifactId === recoveryArtifactId
  ) {
    sessionStorage.setItem(AUTH_ATTEMPT_TAB_KEY, attempts[0].nonce)
    return attempts[0]
  }
  return null
}

function writeAuthAttempts(values: AuthAttempt[]): void {
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  // Analytics-only state: no credential, identity, email, or authorization
  // data. The viewer and root trackers intentionally consume it in JS.
  // react-doctor-disable-next-line react-doctor/insecure-session-cookie
  document.cookie = `${AUTH_ATTEMPT_COOKIE}=${encodeURIComponent(JSON.stringify(values.slice(-MAX_AUTH_ATTEMPTS)))}; Path=/; Max-Age=${AUTH_ATTEMPT_MAX_AGE_SECONDS}; SameSite=Lax${secure}`
}

function artifactIdFromCallback(callbackURL: string): string | undefined {
  try {
    const pathname = new URL(callbackURL, location.origin).pathname
    const match = /^\/a\/([^/]+)$/u.exec(pathname)
    return match?.[1] ? decodeURIComponent(match[1]) : undefined
  } catch {
    return undefined
  }
}

export function captureAuthAttempt(input: {
  method: AnalyticsAuthMethod
  callbackURL: string
  shouldLoadAnalytics: boolean
}): void {
  if (!input.shouldLoadAnalytics || typeof document === 'undefined') return
  const previousTabNonce = sessionStorage.getItem(AUTH_ATTEMPT_TAB_KEY)
  const nonce = crypto.randomUUID()
  sessionStorage.setItem(AUTH_ATTEMPT_TAB_KEY, nonce)
  writeAuthAttempts([
    ...readAuthAttempts().filter(
      (attempt) => attempt.nonce !== previousTabNonce,
    ),
    {
      method: input.method,
      artifactId: artifactIdFromCallback(input.callbackURL),
      authCompletedSent: false,
      nonce,
    },
  ])
}

export function markAuthCompleted(accountState: 'new' | 'existing'): void {
  const attempt = readAuthAttempt()
  if (!attempt) return
  writeAuthAttempts(
    readAuthAttempts().map((candidate) =>
      candidate.nonce === attempt.nonce
        ? { ...candidate, authCompletedSent: true, accountState }
        : candidate,
    ),
  )
}

export function clearAuthAttempt(): void {
  const attempt = readAuthAttempt()
  sessionStorage.removeItem(AUTH_ATTEMPT_TAB_KEY)
  const remaining = attempt
    ? readAuthAttempts().filter(({ nonce }) => nonce !== attempt.nonce)
    : []
  if (remaining.length) {
    writeAuthAttempts(remaining)
    return
  }
  // Clears the same non-authentication analytics state described above.
  // react-doctor-disable-next-line react-doctor/insecure-session-cookie
  document.cookie = `${AUTH_ATTEMPT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}

export function clearAllAuthAttempts(): void {
  sessionStorage.removeItem(AUTH_ATTEMPT_TAB_KEY)
  // react-doctor-disable-next-line react-doctor/insecure-session-cookie
  document.cookie = `${AUTH_ATTEMPT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}
