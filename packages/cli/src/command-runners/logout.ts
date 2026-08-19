import type { LogoutData, OutputMode, ParsedArgs } from '../types.js'
import { CLI_INVOCATION, TOKEN_ENV_VAR } from '../constants.js'
import {
  configHomeUnavailableError,
  profileNotFoundError,
  tokenStoreUnavailableError,
  validationError,
} from '../errors.js'
import { writeFailure, writeSuccess } from '../output.js'
import { apiPostPublic, baseUrlOf, requestConfig } from '../api.js'
import { mapApiError } from '../errors.js'
import { configHome, nonEmpty, readGlobalConfig } from '../token-store.js'
import {
  deleteCredentialForProfileEntry,
  optionsForProfileEntry,
  readCredentialForProfileEntry,
} from './profile-credentials.js'

export async function runLogout(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'logout'
  const explicitProfile = nonEmpty(parsed.options.profile)

  if (!configHome()) {
    return writeFailure(
      command,
      configHomeUnavailableError(explicitProfile),
      mode,
      1,
    )
  }

  const config = (await readGlobalConfig()) ?? {}
  let profile: string
  if (explicitProfile) {
    if (!Object.hasOwn(config.profiles ?? {}, explicitProfile)) {
      return writeFailure(
        command,
        profileNotFoundError(explicitProfile),
        mode,
        1,
      )
    }
    profile = explicitProfile
  } else {
    const defaultProfile = nonEmpty(config.default_profile)
    if (!defaultProfile) {
      const optionToken = nonEmpty(parsed.options.token)
      const envToken = nonEmpty(process.env.ARTIFACTSHARE_TOKEN)
      const tokenOnlyHint =
        optionToken || envToken
          ? `Bearer-token-only auth has no local credential to remove. Pass --profile <name>, set a default profile with ${CLI_INVOCATION} profiles use <name>, or unset ${TOKEN_ENV_VAR} before retrying.`
          : `Pass --profile <name> or run ${CLI_INVOCATION} profiles use <name> first.`
      return writeFailure(
        command,
        validationError('No profile is selected for logout.', tokenOnlyHint),
        mode,
        1,
      )
    }
    if (!Object.hasOwn(config.profiles ?? {}, defaultProfile)) {
      return writeFailure(
        command,
        profileNotFoundError(defaultProfile),
        mode,
        1,
      )
    }
    profile = defaultProfile
  }

  const rawEntry = config.profiles?.[profile]
  const profileOptions = optionsForProfileEntry(rawEntry, parsed.options)
  const stored = await readCredentialForProfileEntry(
    profile,
    rawEntry,
    parsed.options,
  )
  if (stored.ok && stored.credential.kind === 'session') {
    const request = await requestConfig(profileOptions)
    if (request.error) {
      return writeFailure(command, request.error, mode, 1)
    }
    const revoked = await apiPostPublic(
      '/api/cli/auth/revoke',
      { refresh_token: stored.credential.refresh_token },
      profileOptions,
      request.init,
    )
    if (revoked.error) {
      return writeFailure(command, revoked.error, mode, 1)
    }
    if (!revoked.response.ok && revoked.response.status !== 401) {
      return writeFailure(
        command,
        mapApiError(revoked.response.status, revoked.body, {
          baseUrl: baseUrlOf(profileOptions),
        }),
        mode,
        1,
      )
    }
  }
  const deleted = await deleteCredentialForProfileEntry(
    profile,
    rawEntry,
    parsed.options,
  )
  if (!deleted.ok) {
    return writeFailure(
      command,
      tokenStoreUnavailableError(profile, 'store_operation_failed'),
      mode,
      1,
    )
  }

  const data: LogoutData = {
    profile,
    credential_removed: deleted.credential_removed,
    token_store: deleted.token_store,
  }
  return writeSuccess(command, data, mode)
}
