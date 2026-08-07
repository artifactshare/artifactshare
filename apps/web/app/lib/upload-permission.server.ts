import { env } from 'cloudflare:workers'
import {
  evaluateFlagshipFlag,
  type FlagshipFlagsBinding,
} from './flagship-fallback.server'
import { normalizeGrantEmail } from './grant-emails'

export const UPLOAD_ALLOWED_FLAG_KEY = 'upload-allowed'

export type UploadPermissionEnv = {
  APP_ENV: string
  FLAGS?: Partial<FlagshipFlagsBinding>
}

export type UploadPermissionUser = {
  id: string
  email?: string | null
  workspaceId: string
  selfUploadEnabled?: boolean
  hd?: string | null
}

export type UploadPermissionResult =
  | { kind: 'allowed' }
  | { kind: 'not-allowed' }
  | { kind: 'self-upload-disabled' }
  | { kind: 'missing-flagship-binding' }
  | { kind: 'flagship-error'; error: unknown }

export function logUploadPermissionFailure(
  permission: UploadPermissionResult,
): void {
  if (permission.kind === 'missing-flagship-binding') {
    console.error('upload_flagship_binding_missing_in_production')
  }
  if (permission.kind === 'flagship-error') {
    console.error('upload_flagship_evaluation_failed', permission.error)
  }
}

export async function checkUploadPermission(
  user: UploadPermissionUser,
  source: UploadPermissionEnv = env,
): Promise<UploadPermissionResult> {
  const result = await evaluateFlagshipFlag(source, {
    flagKey: UPLOAD_ALLOWED_FLAG_KEY,
    context: uploadPermissionContext(user),
    nonProductionDefault: true,
  })

  switch (result.kind) {
    case 'evaluated':
      return result.enabled ? { kind: 'allowed' } : { kind: 'not-allowed' }
    case 'missing-binding':
      if (result.production) {
        return { kind: 'missing-flagship-binding' }
      }
      return result.enabled ? { kind: 'allowed' } : { kind: 'not-allowed' }
    case 'evaluation-error':
      return { kind: 'flagship-error', error: result.error }
  }
}

function uploadPermissionContext(
  user: UploadPermissionUser,
): Record<string, string> {
  const context: Record<string, string> = {
    targetingKey: user.id,
    userId: user.id,
    workspaceId: user.workspaceId,
  }
  const email = normalizeGrantEmail(user.email)
  if (email) {
    context.email = email
  }
  const hd = user.hd?.trim().toLowerCase()
  if (hd) {
    context.hd = hd
  }
  return context
}
