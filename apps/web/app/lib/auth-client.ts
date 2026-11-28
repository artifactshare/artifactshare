import type { PublisherApproval } from '@artifactshare/contract'
import { z } from 'zod'
import { oauthProviderClient } from '@better-auth/oauth-provider/client'
import { createAuthClient } from 'better-auth/react'
import {
  deviceAuthorizationClient,
  emailOTPClient,
} from 'better-auth/client/plugins'

const publisherClientNameSchema = z
  .string()
  .transform((value) => value.trim().normalize('NFC'))
  .refine(
    (value) =>
      Array.from(value).length >= 1 &&
      Array.from(value).length <= 100 &&
      /^[\p{L}\p{M}\p{N} ._()-]+$/u.test(value) &&
      !/\p{Default_Ignorable_Code_Point}/u.test(value) &&
      /[\p{L}\p{N}._()-]/u.test(value),
    'Use 1–100 letters, marks, numbers, spaces, or ._-()',
  )

const publisherApprovalSchema = z.object({
  preset: z.literal('publisher'),
  requestedName: publisherClientNameSchema,
  clients: z.array(
    z.object({ id: z.string().min(1), name: publisherClientNameSchema }),
  ),
})

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

export function sendSignInOtp(email: string): Promise<AuthActionResult> {
  return authClient.emailOtp.sendVerificationOtp({
    email,
    type: 'sign-in',
  }) as Promise<AuthActionResult>
}

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

export function oauthConsent(accept: boolean): Promise<unknown> {
  return authClient.oauth2.consent({ accept })
}

export function oauthClientInfo(clientId: string): Promise<unknown> {
  return authClient.$fetch('/oauth2/public-client', {
    method: 'GET',
    query: { client_id: clientId },
  })
}

export function deviceVerify(userCode: string): Promise<unknown> {
  return authClient.$fetch('/device', {
    method: 'GET',
    query: { user_code: userCode },
  })
}

export function deviceApprove(
  userCode: string,
  projectId?: string,
  publisher?:
    | { mode: 'create-new' }
    | { mode: 'continue-existing'; client_id: string },
): Promise<unknown> {
  return authClient.$fetch('/device/approve', {
    method: 'POST',
    body: {
      userCode,
      project_id: projectId,
      ...(publisher ? { publisher } : {}),
    },
  })
}

export function deviceDeny(userCode: string): Promise<unknown> {
  return authClient.$fetch('/device/deny', {
    method: 'POST',
    body: { userCode },
  })
}

export async function loadDeviceAgentApproval(userCode: string): Promise<
  | {
      preset: 'agent'
      deviceName: string | null
      projectSelector: string | null
      fixedProject: {
        id: string
        name: string
        baseVisibility: 'workspace' | 'private'
        updatedAt: string
      } | null
      fixedProjectError: boolean
    }
  | PublisherApproval
  | null
> {
  const response = await fetch(
    `/api/cli/device-approval?user_code=${encodeURIComponent(userCode)}`,
    { headers: { accept: 'application/json' } },
  )
  if (!response.ok) throw new Error('Unable to load approval context')
  const body = (await response.json()) as {
    agentApproval?: unknown
    publisherApproval?: unknown
  }
  if (body.publisherApproval)
    return publisherApprovalSchema.parse(body.publisherApproval)
  const approval = body.agentApproval
  if (!approval || typeof approval !== 'object') return null
  return approval as {
    preset: 'agent'
    deviceName: string | null
    projectSelector: string | null
    fixedProject: {
      id: string
      name: string
      baseVisibility: 'workspace' | 'private'
      updatedAt: string
    } | null
    fixedProjectError: boolean
  }
}

export function signInToCurrentPage(): void {
  const next =
    typeof window !== 'undefined'
      ? window.location.pathname + window.location.search
      : '/'
  window.location.href = `/sign-in?next=${encodeURIComponent(next)}`
}
