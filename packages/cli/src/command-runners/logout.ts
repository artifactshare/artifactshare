import type { LogoutData, OutputMode, ParsedArgs } from '../types.js'
import { CLI_INVOCATION, TOKEN_ENV_VAR } from '../constants.js'
import {
  profileNotFoundError,
  tokenStoreUnavailableError,
  validationError,
} from '../errors.js'
import { writeFailure, writeSuccess } from '../output.js'
import { configHome, nonEmpty, readGlobalConfig } from '../token-store.js'
import { deleteCredentialForProfileEntry } from './profile-credentials.js'

export async function runLogout(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'logout'
  const explicitProfile = nonEmpty(parsed.options.profile)

  if (!configHome()) {
    return writeFailure(command, tokenStoreUnavailableError(), mode, 1)
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
  const deleted = await deleteCredentialForProfileEntry(
    profile,
    rawEntry,
    parsed.options,
  )
  if (!deleted.ok) {
    return writeFailure(command, tokenStoreUnavailableError(profile), mode, 1)
  }

  const data: LogoutData = {
    profile,
    credential_removed: deleted.credential_removed,
    token_store: deleted.token_store,
  }
  return writeSuccess(command, data, mode)
}
