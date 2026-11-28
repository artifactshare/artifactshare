import {
  type CliAuthRefreshRequest,
  RotatingCliAuthRefreshResponseSchema,
} from '@artifactshare/contract'
import type {
  CliError,
  FetchInit,
  OutputMode,
  ParsedArgs,
  ProfileConfigEntry,
  ProfilesDeleteData,
  ProfilesImportTokenData,
  ProfilesListData,
  ProfilesListEntry,
} from '../types.js'
import { apiGet, apiPostPublic, baseUrlOf, requestConfig } from '../api.js'
import { CLI_INVOCATION } from '../constants.js'
import { isRecord } from '../validators.js'
import {
  botTokenInvalidError,
  configHomeUnavailableError,
  mapApiError,
  profileNotFoundError,
  tokenStoreUnavailableError,
  validationError,
} from '../errors.js'
import { writeFailure, writeSuccess, writeText } from '../output.js'
import {
  configHome,
  nonEmpty,
  readGlobalConfig,
  probeTokenStoreWritable,
  readProfileToken,
  saveProfileSessionCredential,
  writeGlobalConfig,
} from '../token-store.js'
import { randomUUID } from 'node:crypto'
import { BOT_TOKEN_PREFIX } from '../constants.js'
import { verifyAndStoreApiTokenProfile, whoamiProfile } from './login.js'
import {
  deleteCredentialForProfileEntry,
  readCredentialForProfileEntry,
} from './profile-credentials.js'

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
    return writeFailure(command, configHomeUnavailableError(), mode, 1)
  }
  const config = (await readGlobalConfig()) ?? {}
  const defaultProfile = nonEmpty(config.default_profile) ?? null
  const profiles: ProfilesListEntry[] = await Promise.all(
    Object.entries(config.profiles ?? {}).map(async ([name, rawEntry]) => {
      const entry = isRecord(rawEntry) ? (rawEntry as ProfileConfigEntry) : {}
      const stored = await readCredentialForProfileEntry(
        name,
        rawEntry,
        parsed.options,
      )
      return {
        name,
        base_url: nonEmpty(entry.base_url) ?? null,
        email: nonEmpty(entry.email) ?? null,
        workspace_id: nonEmpty(entry.workspace_id) ?? null,
        token_store: entry.token_store ?? null,
        updated_at: nonEmpty(entry.updated_at) ?? null,
        is_default: name === defaultProfile,
        token_present: stored.ok,
        ...(entry.kind === 'bot' ? { kind: 'bot' as const } : {}),
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
    return writeFailure(command, configHomeUnavailableError(name), mode, 1)
  }
  const config = (await readGlobalConfig()) ?? {}
  if (!Object.hasOwn(config.profiles ?? {}, name)) {
    return writeFailure(command, profileNotFoundError(name), mode, 1)
  }
  const previous = nonEmpty(config.default_profile) ?? null
  const written = await writeGlobalConfig({ ...config, default_profile: name })
  if (!written.ok && written.reason === 'write_failed') throw written.cause
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
    return writeFailure(command, configHomeUnavailableError(profile), mode, 1)
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

  if (token.startsWith(BOT_TOKEN_PREFIX)) {
    return await importBotTokenProfile(command, profile, token, parsed, mode)
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
    return writeFailure(command, configHomeUnavailableError(name), mode, 1)
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
    return writeFailure(
      command,
      tokenStoreUnavailableError(name, 'store_operation_failed'),
      mode,
      1,
    )
  }

  const previousDefault = nonEmpty(config.default_profile) ?? null
  const { [name]: _removed, ...restProfiles } = config.profiles ?? {}
  const defaultProfile =
    config.default_profile === name ? null : (config.default_profile ?? null)
  const written = await writeGlobalConfig({
    ...config,
    default_profile: defaultProfile,
    profiles: restProfiles,
  })
  if (!written.ok && written.reason === 'write_failed') throw written.cause

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

// Every refusal the import can raise on its own, in the order it raises them.
// The rotation that follows consumes the bot token, so anything that could say
// no has to say it here, while the token is still unconsumed.
async function preflightBotTokenImport(
  profile: string,
  parsed: ParsedArgs,
): Promise<{ ok: true; init: FetchInit } | { ok: false; error: CliError }> {
  const config = (await readGlobalConfig()) ?? {}
  const entry = isRecord(config.profiles?.[profile])
    ? (config.profiles?.[profile] as ProfileConfigEntry)
    : undefined

  if (entry && parsed.options.force !== true) {
    const existing = await readProfileToken(profile, {
      ...parsed.options,
      baseUrl: nonEmpty(entry.base_url) ?? baseUrlOf(parsed.options),
    })
    if (existing.ok) {
      return {
        ok: false,
        error: validationError(
          `Profile "${profile}" already has a stored credential.`,
          `Re-run with --force to replace it: printf '%s' "$TOKEN" | ${CLI_INVOCATION} profiles import-token --profile ${profile} --force`,
        ),
      }
    }
  }

  const request = await requestConfig(parsed.options)
  if (request.error) return { ok: false, error: request.error }

  const forcedReplace = Boolean(entry && parsed.options.force === true)
  if (
    !(await probeTokenStoreWritable(profile, parsed.options, {
      existingCredentialRemovedFirst: forcedReplace,
    }))
  ) {
    return {
      ok: false,
      error: tokenStoreUnavailableError(profile, 'native_store_unavailable'),
    }
  }

  if (forcedReplace && entry) {
    const removed = await deleteCredentialForProfileEntry(
      profile,
      entry,
      parsed.options,
    )
    if (!removed.ok) {
      return {
        ok: false,
        error: validationError(
          `The existing credential for profile "${profile}" could not be removed, so the forced import was aborted before consuming the token.`,
          'Fix the credential store (or remove the credential with logout --profile), then re-run the import; the bot token is still unconsumed.',
        ),
      }
    }
  }

  // Writing the config back unchanged proves the profile entry can be saved
  // once the rotated credential exists.
  if (!(await writeGlobalConfig(config)).ok) {
    return {
      ok: false,
      error: tokenStoreUnavailableError(profile, 'config_write_failed'),
    }
  }

  return { ok: true, init: request.init }
}

async function importBotTokenProfile(
  command: string,
  profile: string,
  token: string,
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const preflight = await preflightBotTokenImport(profile, parsed)
  if (!preflight.ok) return writeFailure(command, preflight.error, mode, 1)
  const { init } = preflight

  const rotationRequestId = randomUUID()
  let result = await apiPostPublic(
    '/api/cli/auth/refresh',
    {
      refresh_token: token,
      rotation_request_id: rotationRequestId,
    } satisfies CliAuthRefreshRequest,
    parsed.options,
    init,
  )
  for (let retry = 0; result.error && retry < 2; retry += 1) {
    result = await apiPostPublic(
      '/api/cli/auth/refresh',
      {
        refresh_token: token,
        rotation_request_id: rotationRequestId,
      } satisfies CliAuthRefreshRequest,
      parsed.options,
      init,
    )
  }
  if (result.error) return writeFailure(command, result.error, mode, 1)
  const { response, body } = result
  if (!response.ok) {
    if (response.status === 401) {
      return writeFailure(command, botTokenInvalidError(profile), mode, 1)
    }
    return writeFailure(
      command,
      mapApiError(response.status, body, {
        baseUrl: baseUrlOf(parsed.options),
      }),
      mode,
      1,
    )
  }
  const refresh = RotatingCliAuthRefreshResponseSchema.safeParse(body)
  if (!refresh.success || refresh.data.token_type.toLowerCase() !== 'bearer') {
    return writeFailure(
      command,
      validationError(
        'The refresh response was invalid.',
        'Ask a workspace administrator to reissue the bot token, then retry with the new token.',
        'service_error',
      ),
      mode,
      1,
    )
  }

  const saved = await saveProfileSessionCredential(
    profile,
    {
      kind: 'session',
      session_token: refresh.data.access_token,
      refresh_token: refresh.data.refresh_token,
      expires_at: refresh.data.expires_at,
      refresh_credential_expires_at: refresh.data.refresh_token_expires_at,
    },
    parsed.options,
  )
  if (!saved.ok) {
    return writeFailure(
      command,
      validationError(
        'The rotated bot credential could not be stored; the imported token is now consumed and lost.',
        'Fix the token store, ask a workspace administrator to reissue the bot token, and import the new token.',
        'token_store_unavailable',
      ),
      mode,
      1,
    )
  }

  const whoamiResult = await apiGet(
    '/api/cli/whoami',
    refresh.data.access_token,
    parsed.options,
    init,
    { authenticated: true, baseUrl: baseUrlOf(parsed.options) },
  )
  const whoami = whoamiResult.error ? null : whoamiProfile(whoamiResult.body)

  const latest = (await readGlobalConfig()) ?? {}
  const profiles = latest.profiles ?? {}
  const configSaved = (
    await writeGlobalConfig({
      ...latest,
      default_profile: nonEmpty(latest.default_profile) ?? profile,
      profiles: {
        ...profiles,
        [profile]: {
          ...(isRecord(profiles[profile]) ? profiles[profile] : {}),
          kind: 'bot',
          base_url: baseUrlOf(parsed.options),
          email: whoami?.email ?? null,
          workspace_id: whoami?.workspace_id ?? null,
          token_store: saved.store,
          preset: 'agent',
          updated_at: new Date().toISOString(),
        },
      },
    })
  ).ok
  if (!configSaved) {
    return writeFailure(
      command,
      validationError(
        `The rotated bot credential was stored, but the profile configuration for "${profile}" could not be written.`,
        'Without the config entry the profile loses its bot marker and later auth may attempt a human device login. Fix the config directory (disk space / permissions), then ask a workspace administrator to reissue the bot token and import it again.',
        'service_error',
      ),
      mode,
      1,
    )
  }

  const data: ProfilesImportTokenData = {
    profile,
    token_store: saved.store,
    user: { email: whoami?.email ?? null },
    workspace: {
      id: whoami?.workspace_id ?? null,
      hosted_domain: whoami?.hosted_domain ?? null,
    },
    base_url: baseUrlOf(parsed.options),
    kind: 'bot',
  }
  return writeSuccess(command, data, mode)
}
