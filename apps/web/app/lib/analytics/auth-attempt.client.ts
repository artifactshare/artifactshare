import type { SignupMethod } from '~/services/signup-analytics.server'

export const AUTH_ATTEMPT_COOKIE = '__as_auth_attempt'
const AUTH_ATTEMPT_TAB_KEY = '__as_auth_attempt_nonce'
const AUTH_ATTEMPT_MAX_AGE_SECONDS = 1800

export interface AuthAttempt {
  method: SignupMethod
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

export function readAuthAttempt(): AuthAttempt | null {
  const raw = readCookie()
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<AuthAttempt>
    if (!['google', 'microsoft', 'email'].includes(value.method ?? ''))
      return null
    if (value.artifactId !== undefined && typeof value.artifactId !== 'string')
      return null
    if (typeof value.authCompletedSent !== 'boolean') return null
    if (
      value.accountState !== undefined &&
      !['new', 'existing'].includes(value.accountState)
    )
      return null
    if (!value.nonce || typeof value.nonce !== 'string') return null
    if (sessionStorage.getItem(AUTH_ATTEMPT_TAB_KEY) !== value.nonce)
      return null
    return value as AuthAttempt
  } catch {
    return null
  }
}

function writeAuthAttempt(value: AuthAttempt): void {
  const secure = location.protocol === 'https:' ? '; Secure' : ''
  // Analytics-only state: no credential, identity, email, or authorization
  // data. The viewer and root trackers intentionally consume it in JS.
  // react-doctor-disable-next-line react-doctor/insecure-session-cookie
  document.cookie = `${AUTH_ATTEMPT_COOKIE}=${encodeURIComponent(JSON.stringify(value))}; Path=/; Max-Age=${AUTH_ATTEMPT_MAX_AGE_SECONDS}; SameSite=Lax${secure}`
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
  method: SignupMethod
  callbackURL: string
  shouldLoadAnalytics: boolean
}): void {
  if (!input.shouldLoadAnalytics || typeof document === 'undefined') return
  const nonce = crypto.randomUUID()
  sessionStorage.setItem(AUTH_ATTEMPT_TAB_KEY, nonce)
  writeAuthAttempt({
    method: input.method,
    artifactId: artifactIdFromCallback(input.callbackURL),
    authCompletedSent: false,
    nonce,
  })
}

export function markAuthCompleted(accountState: 'new' | 'existing'): void {
  const attempt = readAuthAttempt()
  if (!attempt) return
  writeAuthAttempt({
    ...attempt,
    authCompletedSent: true,
    accountState,
  })
}

export function clearAuthAttempt(): void {
  sessionStorage.removeItem(AUTH_ATTEMPT_TAB_KEY)
  // Clears the same non-authentication analytics state described above.
  // react-doctor-disable-next-line react-doctor/insecure-session-cookie
  document.cookie = `${AUTH_ATTEMPT_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`
}
