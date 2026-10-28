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

/** Only the server knows workspace capability; absent legacy fields stay unknown. */
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
  )
  if (result.error) return { error: result.error }
  const workspace =
    isRecord(result.body) && isRecord(result.body.workspace)
      ? result.body.workspace
      : null
  const privateDefault = workspace?.visibility_available === false
  return {
    ...resolution,
    value: privateDefault ? 'private' : 'workspace',
    privateDefault,
  }
}
