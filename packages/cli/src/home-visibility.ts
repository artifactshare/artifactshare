import { apiGet } from './api.js'
import type { VisibilityResolution } from './destination.js'
import type {
  ApiErrorOptions,
  CliError,
  CliOptions,
  FetchInit,
} from './types.js'
import { isRecord } from './validators.js'

export const PRIVATE_DEFAULT_HINT =
  'Workspace visibility is unavailable for this account, so Home defaults to private. Choose --visibility link deliberately to share with anyone who has the link.'

/**
 * Only the server knows workspace capability. Credential failures go back to
 * the caller's sign-in handling; any other failure, or an older server that
 * omits the field, keeps the product default, which the server still rejects
 * for personal accounts, so nothing is published more widely.
 */
export async function resolveAccountHomeVisibility(
  resolution: VisibilityResolution,
  token: string,
  options: CliOptions,
  init: FetchInit,
  errorOptions: ApiErrorOptions,
): Promise<
  (VisibilityResolution & { privateDefault: boolean }) | { error: CliError }
> {
  if (resolution.source !== 'product_default') {
    return { ...resolution, privateDefault: false }
  }
  const result = await apiGet(
    '/api/cli/whoami',
    token,
    options,
    init,
    errorOptions,
  ).catch(() => null)
  if (
    result?.error?.code === 'auth_required' ||
    result?.error?.code === 'token_invalid'
  )
    return { error: result.error }
  const workspace =
    result && !result.error && isRecord(result.body)
      ? result.body.workspace
      : null
  const privateDefault =
    isRecord(workspace) && workspace.visibility_available === false
  return {
    ...resolution,
    value: privateDefault ? 'private' : resolution.value,
    privateDefault,
  }
}
