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
  try {
    const prefix = `${AUTH_ATTEMPT_COOKIE}=`
    const raw = document.cookie
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
    if (!raw) return null
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

function readTabNonce(): string | null {
  try {
    return sessionStorage.getItem(AUTH_ATTEMPT_TAB_KEY)
  } catch {
    return null
  }
}

function writeTabNonce(nonce: string): boolean {
  try {
    sessionStorage.setItem(AUTH_ATTEMPT_TAB_KEY, nonce)
    return true
  } catch {
    return false
  }
}

function removeTabNonce(): void {
  try {
    sessionStorage.removeItem(AUTH_ATTEMPT_TAB_KEY)
  } catch {
    // Analytics state must never interrupt authentication or rendering.
  }
}

export function readAuthAttempt(): AuthAttempt | null {
  const attempts = readAuthAttempts()
  const tabNonce = readTabNonce()
  if (tabNonce) return attempts.find(({ nonce }) => nonce === tabNonce) ?? null
  // The shared cookie cannot distinguish a tab that lost sessionStorage from
  // another open tab showing the same artifact. Recovering by artifact would
  // let both tabs emit auth_completed, so analytics fails closed instead.
  return null
}

function writeAuthAttempts(values: AuthAttempt[]): boolean {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : ''
    // Analytics-only state: no credential, identity, email, or authorization
    // data. The viewer and root trackers intentionally consume it in JS.
    // react-doctor-disable-next-line react-doctor/insecure-session-cookie
    document.cookie = `${AUTH_ATTEMPT_COOKIE}=${encodeURIComponent(JSON.stringify(values.slice(-MAX_AUTH_ATTEMPTS)))}; Path=/; Max-Age=${AUTH_ATTEMPT_MAX_AGE_SECONDS}; SameSite=Lax${secure}`
    return true
  } catch {
    return false
  }
}

function expireAuthAttemptCookie(): void {
  try {
    // react-doctor-disable-next-line react-doctor/insecure-session-cookie
    document.cookie = `${AUTH_ATTEMPT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
  } catch {
    // Analytics state must never interrupt authentication or rendering.
  }
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
  const previousTabNonce = readTabNonce()
  let nonce: string
  try {
    nonce = crypto.randomUUID()
  } catch {
    return
  }
  if (!writeTabNonce(nonce)) return
  const stored = writeAuthAttempts([
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
  if (!stored) removeTabNonce()
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
  removeTabNonce()
  const remaining = attempt
    ? readAuthAttempts().filter(({ nonce }) => nonce !== attempt.nonce)
    : []
  if (remaining.length) {
    writeAuthAttempts(remaining)
    return
  }
  expireAuthAttemptCookie()
}

export function clearAllAuthAttempts(): void {
  removeTabNonce()
  expireAuthAttemptCookie()
}
