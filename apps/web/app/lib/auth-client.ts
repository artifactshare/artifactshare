import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthClient } from 'better-auth/react'
import {
  deviceAuthorizationClient,
  emailOTPClient,
} from 'better-auth/client/plugins'

// baseURL を省くと現在の origin にフォールバックする (localhost dev / 本番同一)。
// authClient 自体は export しない: oauth-provider プラグインの推論型がポータブル
// でないため (TS2883)。必要なアクションだけを名前付きで切り出す。
const authClient = createAuthClient({
  plugins: [
    oauthProviderClient(),
    deviceAuthorizationClient(),
    emailOTPClient(),
  ],
})

export const { signIn, signOut } = authClient

type AuthActionResult = { data?: unknown; error?: { code?: string } }

/** Email a one-time sign-in code to the address. */
export function sendSignInOtp(email: string): Promise<AuthActionResult> {
  return authClient.emailOtp.sendVerificationOtp({
    email,
    type: 'sign-in',
  }) as Promise<AuthActionResult>
}

/**
 * Verify the one-time code and sign in. First-time addresses are auto-created
 * (the server runs the workspace hook); `name` seeds the display name only on
 * that first sign-in. Returns the raw result so the caller can branch on
 * `error.code` (e.g. INVALID_OTP). No redirect — the caller navigates on success.
 */
export function signInWithOtp(
  email: string,
  otp: string,
  name: string,
): Promise<AuthActionResult> {
  return authClient.signIn.emailOtp({
    email,
    otp,
    name,
  }) as Promise<AuthActionResult>
}

/**
 * Accept or deny the pending OAuth consent. Returns the raw client result (a
 * redirect descriptor on success); the caller pulls the redirect URL out of it.
 */
export function oauthConsent(accept: boolean): Promise<unknown> {
  return authClient.oauth2.consent({ accept })
}

/**
 * Public (pre-consent) fields of an OAuth client, looked up by `client_id`.
 * Returns the raw client result; the caller reads the display name out of it.
 * Used to show the connecting app's name on the consent screen instead of the
 * opaque client id.
 */
export function oauthClientInfo(clientId: string): Promise<unknown> {
  return authClient.$fetch('/oauth2/public-client', {
    method: 'GET',
    query: { client_id: clientId },
  })
}

/**
 * Look up a pending device-authorization request by its user code. Signing in
 * first claims the code for the current session, so the page must be gated
 * behind auth before calling this. Returns the raw client result; the caller
 * reads `data.status` (pending / approved / denied) or `error.status` out of it.
 */
export function deviceVerify(userCode: string): Promise<unknown> {
  return authClient.$fetch('/device', {
    method: 'GET',
    query: { user_code: userCode },
  })
}

/**
 * Approve the pending device authorization for the given user code. Requires a
 * session (claimed via `deviceVerify`); returns the raw client result so the
 * caller can branch on `error.status` (e.g. 401 → re-auth, 400 → already
 * handled).
 */
export function deviceApprove(
  userCode: string,
  projectId?: string,
): Promise<unknown> {
  return authClient.$fetch('/device/approve', {
    method: 'POST',
    body: { userCode, project_id: projectId },
  })
}

/** Deny the pending device authorization. See `deviceApprove` for the result shape. */
export function deviceDeny(userCode: string): Promise<unknown> {
  return authClient.$fetch('/device/deny', {
    method: 'POST',
    body: { userCode },
  })
}

export async function loadDeviceAgentApproval(userCode: string): Promise<{
  preset: 'agent'
  deviceName: string | null
} | null> {
  const response = await fetch(
    `/api/cli/device-approval?user_code=${encodeURIComponent(userCode)}`,
    { headers: { accept: 'application/json' } },
  )
  if (!response.ok) return null
  const body = (await response.json()) as { agentApproval?: unknown }
  const approval = body.agentApproval
  if (!approval || typeof approval !== 'object') return null
  return approval as {
    preset: 'agent'
    deviceName: string | null
  }
}

export function signInToCurrentPage(): void {
  const next =
    typeof window !== 'undefined'
      ? window.location.pathname + window.location.search
      : '/'
  window.location.href = `/sign-in?next=${encodeURIComponent(next)}`
}
