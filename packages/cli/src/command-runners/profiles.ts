import type {
  OutputMode,
  ParsedArgs,
  ProfileConfigEntry,
  ProfilesDeleteData,
  ProfilesImportTokenData,
  ProfilesListData,
  ProfilesListEntry,
} from '../types.js'
import { baseUrlOf, requestConfig } from '../api.js'
import { CLI_INVOCATION, DEFAULT_BASE_URL } from '../constants.js'
import { isRecord } from '../validators.js'
import {
  profileNotFoundError,
  tokenStoreUnavailableError,
  validationError,
} from '../errors.js'
import { writeFailure, writeSuccess, writeText } from '../output.js'
import {
  configHome,
  nonEmpty,
  readGlobalConfig,
  readProfileToken,
  writeGlobalConfig,
} from '../token-store.js'
import { verifyAndStoreApiTokenProfile } from './login.js'
import { deleteCredentialForProfileEntry } from './profile-credentials.js'

async function readStdinToken(): Promise<string> {
  if (process.stdin.isTTY === true) return ''
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf8').trim()
}

export async function runProfilesList(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'profiles list'
  if (!configHome()) {
    return writeFailure(command, tokenStoreUnavailableError(), mode, 1)
  }
  const config = (await readGlobalConfig()) ?? {}
  const defaultProfile = nonEmpty(config.default_profile) ?? null
  const profiles: ProfilesListEntry[] = await Promise.all(
    Object.entries(config.profiles ?? {}).map(async ([name, rawEntry]) => {
      const entry = isRecord(rawEntry) ? (rawEntry as ProfileConfigEntry) : {}
      // Each profile is bound to the base URL it logged in against, so the
      // token lookup must use that URL — never the current --base-url.
      const stored = await readProfileToken(name, {
        ...parsed.options,
        baseUrl: nonEmpty(entry.base_url) ?? DEFAULT_BASE_URL,
      })
      return {
        name,
        base_url: nonEmpty(entry.base_url) ?? null,
        email: nonEmpty(entry.email) ?? null,
        workspace_id: nonEmpty(entry.workspace_id) ?? null,
        token_store: entry.token_store ?? null,
        updated_at: nonEmpty(entry.updated_at) ?? null,
        is_default: name === defaultProfile,
        token_present: stored.ok,
      }
    }),
  )
  const data: ProfilesListData = { default_profile: defaultProfile, profiles }
  writeSuccess(command, data, mode)
  if (!mode.json && profiles.length === 0) {
    writeText(
      `No profiles yet. Run ${CLI_INVOCATION} login --profile default to create one.\n`,
    )
  }
}

export async function runProfilesUse(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'profiles use'
  const name = nonEmpty(parsed.positionals[0])
  if (!name) {
    return writeFailure(
      command,
      validationError(
        'A profile name is required.',
        `Run ${CLI_INVOCATION} profiles use <name>.`,
      ),
      mode,
      1,
    )
  }
  if (!configHome()) {
    return writeFailure(command, tokenStoreUnavailableError(), mode, 1)
  }
  const config = (await readGlobalConfig()) ?? {}
  // Object.hasOwn keeps inherited keys ("constructor" etc.) from passing as
  // saved profile names.
  if (!Object.hasOwn(config.profiles ?? {}, name)) {
    return writeFailure(command, profileNotFoundError(name), mode, 1)
  }
  const previous = nonEmpty(config.default_profile) ?? null
  await writeGlobalConfig({ ...config, default_profile: name })
  return writeSuccess(
    command,
    { default_profile: name, previous_default: previous },
    mode,
  )
}

export async function runProfilesImportToken(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'profiles import-token'
  const profile = nonEmpty(parsed.options.profile)
  if (!profile) {
    return writeFailure(
      command,
      validationError(
        'A profile name is required.',
        `Run ${CLI_INVOCATION} profiles import-token --profile <name>.`,
      ),
      mode,
      1,
    )
  }
  if (!configHome()) {
    return writeFailure(command, tokenStoreUnavailableError(profile), mode, 1)
  }
  if (nonEmpty(parsed.options.token)) {
    return writeFailure(
      command,
      validationError(
        'Do not pass API tokens with --token to import-token.',
        'Pipe the token on standard input so it does not appear in process arguments.',
      ),
      mode,
      1,
    )
  }
  if (parsed.positionals.length > 0) {
    return writeFailure(
      command,
      validationError(
        'Do not pass API tokens as positional arguments.',
        `Pipe a token: printf '%s' "$TOKEN" | ${CLI_INVOCATION} profiles import-token --profile ${profile} --json`,
      ),
      mode,
      1,
    )
  }

  let token: string
  try {
    token = await readStdinToken()
  } catch {
    return writeFailure(
      command,
      validationError(
        'The token could not be read from standard input.',
        `Pipe a token: printf '%s' "$TOKEN" | ${CLI_INVOCATION} profiles import-token --profile ${profile} --json`,
        'service_error',
      ),
      mode,
      1,
    )
  }
  if (!token) {
    return writeFailure(
      command,
      validationError(
        'A token is required on standard input.',
        `Pipe a token: printf '%s' "$TOKEN" | ${CLI_INVOCATION} profiles import-token --profile ${profile} --json`,
      ),
      mode,
      1,
    )
  }

  const request = await requestConfig(parsed.options)
  if (request.error) {
    return writeFailure(command, request.error, mode, 1)
  }

  const stored = await verifyAndStoreApiTokenProfile(
    profile,
    token,
    parsed.options,
    request.init,
  )
  if (!stored.ok) return writeFailure(command, stored.error, mode, 1)

  const data: ProfilesImportTokenData = {
    profile,
    token_store: stored.data.token_store,
    user: stored.data.user,
    workspace: stored.data.workspace,
    base_url: baseUrlOf(parsed.options),
  }
  return writeSuccess(command, data, mode)
}

export async function runProfilesDelete(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'profiles delete'
  const name = nonEmpty(parsed.positionals[0])
  if (!name) {
    return writeFailure(
      command,
      validationError(
        'A profile name is required.',
        `Run ${CLI_INVOCATION} profiles delete <name>.`,
      ),
      mode,
      1,
    )
  }
  if (!configHome()) {
    return writeFailure(command, tokenStoreUnavailableError(), mode, 1)
  }
  const config = (await readGlobalConfig()) ?? {}
  if (!Object.hasOwn(config.profiles ?? {}, name)) {
    return writeFailure(command, profileNotFoundError(name), mode, 1)
  }

  const rawEntry = config.profiles?.[name]
  const deleted = await deleteCredentialForProfileEntry(
    name,
    rawEntry,
    parsed.options,
  )
  if (!deleted.ok) {
    return writeFailure(command, tokenStoreUnavailableError(name), mode, 1)
  }

  const previousDefault = nonEmpty(config.default_profile) ?? null
  const { [name]: _removed, ...restProfiles } = config.profiles ?? {}
  const defaultProfile =
    config.default_profile === name ? null : (config.default_profile ?? null)
  await writeGlobalConfig({
    ...config,
    default_profile: defaultProfile,
    profiles: restProfiles,
  })

  const data: ProfilesDeleteData = {
    profile: name,
    credential_removed: deleted.credential_removed,
    token_store: deleted.token_store,
    profile_deleted: true,
    previous_default: previousDefault,
    default_profile: defaultProfile,
  }
  return writeSuccess(command, data, mode)
}
