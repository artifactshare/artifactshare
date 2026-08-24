import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { arch, platform } from 'node:os'
import type {
  CliError,
  CliOptions,
  FetchInit,
  OutputMode,
  ParsedArgs,
  PendingDeviceAuth,
  TokenStoreKind,
} from '../types.js'
import {
  apiGet,
  apiPost,
  apiUrl,
  baseUrlOf,
  cliFetch,
  readJson,
  requestConfig,
} from '../api.js'
import { DEVICE_CLIENT_ID } from '../constants.js'
import {
  authAccountMismatchError,
  authDeniedError,
  authExpiredError,
  mapApiError,
  networkError,
  tokenStoreUnavailableError,
  validationError,
} from '../errors.js'
import { openDeviceAuthorizationUrl } from '../process.js'
import { writeEvent, writeFailure, writeSuccess, writeText } from '../output.js'
import { resolveEffectiveDefaultProfile } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import {
  nonEmpty,
  readGlobalConfig,
  readProfileToken,
  probeTokenStoreWritable,
  saveProfileApiTokenCredential,
  saveProfileSessionCredential,
  writeGlobalConfig,
} from '../token-store.js'
import { isRecord } from '../validators.js'

type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

type DeviceTokenResponse = {
  access_token: string
  token_type: string
  expires_in?: number
}

export type CliAuthorizationPreset = 'unrestricted' | 'agent'

export type WhoamiProfile = {
  email: string | null
  workspace_id: string | null
  hosted_domain: string | null
}

export type DeviceLoginSuccess = {
  profile: string
  status: 'completed'
  credential_source: 'profile'
  token_store: TokenStoreKind
  user: { email: string | null }
  workspace: {
    id: string | null
    hosted_domain: string | null
  }
  verification_uri: string
  verification_uri_complete: string | null
  user_code: string
  expires_at: string | null
  interval_seconds: number
  effective_default_profile?: string | null
  profile_switch_hint?: string
}

export type DeviceLoginResult =
  | { ok: true; data: DeviceLoginSuccess }
  | { ok: false; error: CliError }

type StoredProfileTokenData = {
  profile: string
  token_store: TokenStoreKind
  user: { email: string | null }
  workspace: {
    id: string | null
    hosted_domain: string | null
  }
}

export type StoreProfileTokenResult =
  | { ok: true; data: StoredProfileTokenData }
  | { ok: false; error: CliError }

export type DeviceTokenExchangeResult =
  | { status: 'success'; token: DeviceTokenResponse }
  | { status: 'pending' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'retry_later' }
  | { status: 'slow_down' }
  | { error: CliError }

export async function performDeviceLogin(
  profile: string,
  options: CliOptions,
  mode: OutputMode,
): Promise<DeviceLoginResult> {
  const preset = await resolveAuthorizationPreset(profile, options)
  if ('error' in preset) return { ok: false, error: preset.error }
  if (!(await probeTokenStoreWritable(profile, options))) {
    return {
      ok: false,
      error: tokenStoreUnavailableError(profile, 'native_store_unavailable'),
    }
  }
  const request = await requestConfig(options)
  if (request.error) return { ok: false, error: request.error }

  const code = await requestDeviceCode(options, request.init, {
    preset: preset.value,
    deviceName: deviceNameForProfile(profile),
  })
  if ('error' in code) return { ok: false, error: code.error }
  const deadline = Date.now() + code.expires_in * 1000

  if (mode.json) {
    const authorizationUrl =
      code.verification_uri_complete ?? code.verification_uri
    const browserOpen = await openDeviceAuthorizationUrl(authorizationUrl)
    writeEvent({
      status: 'pending',
      verification_uri: code.verification_uri,
      verification_uri_complete: code.verification_uri_complete ?? null,
      user_code: code.user_code,
      expires_at: new Date(deadline).toISOString(),
      interval_seconds: code.interval,
      browser_open: browserOpen,
    })
  } else {
    writeText(
      [
        'Open this URL in a browser to sign in:',
        code.verification_uri_complete ?? code.verification_uri,
        '',
        `Code: ${code.user_code}`,
        `Waiting for approval for profile "${profile}"...`,
        '',
      ].join('\n'),
    )
  }

  const token = await pollForToken(
    options,
    code,
    request.init,
    profile,
    deadline,
  )
  if ('error' in token) return { ok: false, error: token.error }
  const sessionExpiresAt =
    token.expires_in === undefined
      ? null
      : new Date(Date.now() + token.expires_in * 1000).toISOString()

  const stored = await verifyAndStoreProfileToken(
    profile,
    token.access_token,
    options,
    request.init,
    sessionExpiresAt,
  )
  if (!stored.ok) return { ok: false, error: stored.error }
  const effective = await resolveEffectiveDefaultProfile(
    await resolveProjectConfig(),
  )

  const data: DeviceLoginSuccess = {
    profile,
    status: 'completed',
    credential_source: 'profile',
    token_store: stored.data.token_store,
    user: stored.data.user,
    workspace: stored.data.workspace,
    verification_uri: code.verification_uri,
    verification_uri_complete: code.verification_uri_complete ?? null,
    user_code: code.user_code,
    expires_at: sessionExpiresAt,
    interval_seconds: code.interval,
  }
  if (effective.profile && effective.profile !== profile) {
    data.effective_default_profile = effective.profile
    data.profile_switch_hint = `Saved credentials for "${profile}", but the current default profile is "${effective.profile}". Run with --profile ${profile}, init --profile ${profile}, or profiles use ${profile} before the next command.`
  }

  return { ok: true, data }
}

export async function runLogin(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'login'
  const profile = nonEmpty(parsed.options.profile) ?? 'default'
  if (
    nonEmpty(process.env.ARTIFACTSHARE_TOKEN) ||
    nonEmpty(parsed.options.token)
  ) {
    return writeFailure(
      command,
      validationError(
        'Login cannot run with a bearer token already selected.',
        'Unset ARTIFACTSHARE_TOKEN and remove --token before running login.',
      ),
      mode,
      1,
    )
  }

  const result = await performDeviceLogin(profile, parsed.options, mode)
  if (!result.ok) return writeFailure(command, result.error, mode, 1)
  return writeSuccess(command, result.data, mode)
}

export async function requestDeviceCode(
  options: CliOptions,
  init: FetchInit,
  authorization?: {
    preset: CliAuthorizationPreset
    deviceName: string
  },
): Promise<DeviceCodeResponse | { error: CliError }> {
  const response = await cliFetch(
    apiUrl('/api/auth/device/code', baseUrlOf(options)),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: DEVICE_CLIENT_ID,
        preset: authorization?.preset ?? 'unrestricted',
        device_name: authorization?.deviceName,
      }),
      ...init,
    },
  )
  if ('networkError' in response) {
    return { error: networkError(response.networkError) }
  }
  const body = await readJson(response)
  if (!response.ok) {
    return {
      error: mapApiError(response.status, body, {
        baseUrl: baseUrlOf(options),
      }),
    }
  }
  if (!isDeviceCodeResponse(body)) {
    return {
      error: validationError(
        'Device login response was invalid.',
        'Retry login. If this repeats, report the response shape.',
        'service_error',
      ),
    }
  }
  return body
}

export async function exchangeDeviceTokenOnce(
  options: CliOptions,
  deviceCode: string,
  init: FetchInit,
): Promise<DeviceTokenExchangeResult> {
  const response = await cliFetch(
    apiUrl('/api/auth/device/token', baseUrlOf(options)),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        client_id: DEVICE_CLIENT_ID,
      }),
      ...init,
    },
  )
  if ('networkError' in response) {
    return { error: networkError(response.networkError) }
  }
  const body = await readJson(response)
  if (response.ok && isDeviceTokenResponse(body)) {
    return { status: 'success', token: body }
  }
  const authError = deviceTokenError(body)
  if (authError === 'authorization_pending') return { status: 'pending' }
  if (authError === 'slow_down') return { status: 'slow_down' }
  if (authError === 'access_denied') return { status: 'denied' }
  if (authError === 'expired_token') return { status: 'expired' }
  if (response.status === 429 || response.status >= 500) {
    return { status: 'retry_later' }
  }
  return {
    error: mapApiError(response.status, body, {
      baseUrl: baseUrlOf(options),
    }),
  }
}

export function pendingDeviceAuthFromCode(
  profile: string,
  options: CliOptions,
  code: DeviceCodeResponse,
): PendingDeviceAuth {
  const baseUrl = baseUrlOf(options)
  return {
    base_url: baseUrl,
    profile,
    preset: options.preset === 'agent' ? 'agent' : 'unrestricted',
    device_code: code.device_code,
    verification_uri: code.verification_uri,
    verification_uri_complete: code.verification_uri_complete ?? null,
    user_code: code.user_code,
    expires_at: new Date(Date.now() + code.expires_in * 1000).toISOString(),
    interval_seconds: code.interval,
    created_at: new Date().toISOString(),
  }
}

async function pollForToken(
  options: CliOptions,
  code: DeviceCodeResponse,
  init: FetchInit,
  profile: string,
  deadline: number,
): Promise<DeviceTokenResponse | { error: CliError }> {
  let intervalMs = Math.max(code.interval, 1) * 1000
  let networkFailures = 0
  while (Date.now() < deadline) {
    await delay(intervalMs)
    const response = await cliFetch(
      apiUrl('/api/auth/device/token', baseUrlOf(options)),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: code.device_code,
          client_id: DEVICE_CLIENT_ID,
        }),
        ...init,
      },
    )
    if ('networkError' in response) {
      // A transient blip must not abort a wait that can legitimately last
      // the whole device-code lifetime (the user may have already approved).
      networkFailures += 1
      if (networkFailures >= 5) {
        return { error: networkError(response.networkError) }
      }
      continue
    }
    networkFailures = 0
    const body = await readJson(response)
    if (response.ok && isDeviceTokenResponse(body)) return body
    const authError = deviceTokenError(body)
    if (authError === 'authorization_pending') continue
    if (authError === 'slow_down') {
      intervalMs += 5000
      continue
    }
    if (authError === 'access_denied')
      return { error: authDeniedError(profile) }
    if (authError === 'expired_token') {
      return { error: authExpiredError(profile) }
    }
    return {
      error: mapApiError(response.status, body, {
        baseUrl: baseUrlOf(options),
      }),
    }
  }
  return { error: authExpiredError(profile) }
}

export async function verifyAndStoreProfileToken(
  profile: string,
  token: string,
  options: CliOptions,
  init: FetchInit,
  sessionExpiresAt: string | null = null,
): Promise<StoreProfileTokenResult> {
  const verified = await verifyProfileTokenAccount(
    profile,
    token,
    options,
    init,
  )
  if (!verified.ok) return verified

  const stored = await readProfileToken(profile, options)
  const storedDeviceId =
    stored.ok && stored.credential.kind === 'session'
      ? nonEmpty(stored.credential.device_id)
      : null
  const deviceId = storedDeviceId ?? randomUUID()
  const deviceSuffix = `, ${deviceId.slice(0, 8)})`
  const devicePrefix = `Artifact Share CLI on ${platform()} ${arch()} (`
  const profileBudget = Math.max(
    0,
    100 - devicePrefix.length - deviceSuffix.length,
  )
  const deviceName = `${devicePrefix}${profile.slice(0, profileBudget)}${deviceSuffix}`
  const refresh = await issueCliRefreshCredential(
    token,
    deviceName,
    deviceId,
    options,
    init,
  )
  if ('error' in refresh) return { ok: false, error: refresh.error }

  const saved = await saveProfileSessionCredential(
    profile,
    {
      kind: 'session',
      session_token: token,
      refresh_token: refresh.refresh_token,
      expires_at: sessionExpiresAt,
      device_id: deviceId,
    },
    options,
  )
  if (!saved.ok) {
    return { ok: false, error: tokenStoreUnavailableError(profile) }
  }
  await writeProfileConfig(profile, options, saved.store, verified.whoami)

  return {
    ok: true,
    data: {
      profile,
      token_store: saved.store,
      user: { email: verified.whoami.email },
      workspace: {
        id: verified.whoami.workspace_id,
        hosted_domain: verified.whoami.hosted_domain,
      },
    },
  }
}

export async function verifyAndStoreApiTokenProfile(
  profile: string,
  token: string,
  options: CliOptions,
  init: FetchInit,
): Promise<StoreProfileTokenResult> {
  const verified = await verifyProfileTokenAccount(
    profile,
    token,
    options,
    init,
  )
  if (!verified.ok) return verified

  const saved = await saveProfileApiTokenCredential(
    profile,
    { kind: 'api_token', token },
    options,
  )
  if (!saved.ok) {
    return { ok: false, error: tokenStoreUnavailableError(profile) }
  }
  await writeProfileConfig(profile, options, saved.store, verified.whoami)

  return {
    ok: true,
    data: {
      profile,
      token_store: saved.store,
      user: { email: verified.whoami.email },
      workspace: {
        id: verified.whoami.workspace_id,
        hosted_domain: verified.whoami.hosted_domain,
      },
    },
  }
}

async function verifyProfileTokenAccount(
  profile: string,
  token: string,
  options: CliOptions,
  init: FetchInit,
): Promise<
  { ok: true; whoami: WhoamiProfile } | { ok: false; error: CliError }
> {
  const config = (await readGlobalConfig()) ?? {}
  const whoamiResult = await apiGet('/api/cli/whoami', token, options, init, {
    authenticated: true,
    baseUrl: baseUrlOf(options),
  })
  if (whoamiResult.error) {
    return { ok: false, error: whoamiResult.error }
  }
  const whoami = whoamiProfile(whoamiResult.body)

  const profiles = config.profiles ?? {}
  const currentProfile = Object.hasOwn(profiles, profile)
    ? profiles[profile]
    : undefined
  const expectedEmail = nonEmpty(currentProfile?.email)
  if (expectedEmail && whoami.email !== expectedEmail) {
    return {
      ok: false,
      error: authAccountMismatchError(profile, expectedEmail, whoami.email),
    }
  }
  return { ok: true, whoami }
}

async function issueCliRefreshCredential(
  token: string,
  deviceName: string,
  deviceId: string,
  options: CliOptions,
  init: FetchInit,
): Promise<
  | { refresh_token: string; refresh_token_expires_at: string }
  | { error: CliError }
> {
  const result = await apiPost(
    '/api/cli/auth/refresh-credentials',
    token,
    { device_name: deviceName, device_id: deviceId },
    options,
    init,
    {
      authenticated: true,
      baseUrl: baseUrlOf(options),
    },
  )
  if (result.error) return { error: result.error }
  if (
    typeof result.body?.refresh_token === 'string' &&
    typeof result.body.refresh_token_expires_at === 'string'
  ) {
    return {
      refresh_token: result.body.refresh_token,
      refresh_token_expires_at: result.body.refresh_token_expires_at,
    }
  }
  return {
    error: validationError(
      'Refresh credential response was invalid.',
      'Retry login. If this repeats, report the response shape.',
      'service_error',
    ),
  }
}

export async function writeProfileConfig(
  profile: string,
  options: CliOptions,
  tokenStore: TokenStoreKind,
  whoami: WhoamiProfile,
) {
  // Re-read just before writing so a concurrent login for another profile is
  // not clobbered by a stale snapshot.
  const config = (await readGlobalConfig()) ?? {}
  const profiles = config.profiles ?? {}
  const currentProfile = Object.hasOwn(profiles, profile)
    ? profiles[profile]
    : undefined
  await writeGlobalConfig({
    ...config,
    default_profile: nonEmpty(config.default_profile) ?? profile,
    profiles: {
      ...profiles,
      [profile]: {
        // Rebuild rather than spread so a stale kind:'bot' marker from a
        // replaced bot profile is dropped: keeping it would route a later
        // expiry into the bot "ask for reissue" dead end instead of reauth.
        ...(currentProfile
          ? Object.fromEntries(
              Object.entries(currentProfile).filter(([key]) => key !== 'kind'),
            )
          : {}),
        base_url: baseUrlOf(options),
        email: whoami.email ?? currentProfile?.email ?? null,
        workspace_id: whoami.workspace_id,
        token_store: tokenStore,
        preset:
          options.preset === 'agent' || options.preset === 'unrestricted'
            ? options.preset
            : (currentProfile?.preset ?? 'unrestricted'),
        updated_at: new Date().toISOString(),
      },
    },
  })
}

async function resolveAuthorizationPreset(
  profile: string,
  options: CliOptions,
): Promise<
  | { value: CliAuthorizationPreset; error?: never }
  | { error: CliError; value?: never }
> {
  const requested = nonEmpty(options.preset)
  if (requested && requested !== 'agent' && requested !== 'unrestricted') {
    return {
      error: validationError(
        `Unknown authorization preset: ${requested}`,
        'Use --preset agent or --preset unrestricted.',
      ),
    }
  }
  if (requested === 'agent' || requested === 'unrestricted') {
    return { value: requested }
  }
  const stored = (await readGlobalConfig())?.profiles?.[profile]?.preset
  return { value: stored ?? 'unrestricted' }
}

export function deviceNameForProfile(profile: string): string {
  const prefix = `Artifact Share CLI on ${platform()} ${arch()} (`
  return `${prefix}${profile.slice(0, Math.max(0, 99 - prefix.length))})`
}

function isDeviceCodeResponse(body: unknown): body is DeviceCodeResponse {
  if (!isRecord(body)) return false
  return (
    typeof body.device_code === 'string' &&
    typeof body.user_code === 'string' &&
    typeof body.verification_uri === 'string' &&
    (typeof body.verification_uri_complete === 'string' ||
      body.verification_uri_complete === undefined) &&
    typeof body.expires_in === 'number' &&
    typeof body.interval === 'number'
  )
}

function isDeviceTokenResponse(body: unknown): body is DeviceTokenResponse {
  if (!isRecord(body)) return false
  return (
    typeof body.access_token === 'string' &&
    typeof body.token_type === 'string' &&
    body.token_type.toLowerCase() === 'bearer' &&
    (typeof body.expires_in === 'number' || body.expires_in === undefined)
  )
}

function deviceTokenError(body: unknown): string | null {
  if (!isRecord(body)) return null
  return typeof body.error === 'string' ? body.error : null
}

export function whoamiProfile(body: unknown): WhoamiProfile {
  const record = isRecord(body) ? body : null
  const user = record && isRecord(record.user) ? record.user : null
  const workspace =
    record && isRecord(record.workspace) ? record.workspace : null
  return {
    email: typeof user?.email === 'string' ? user.email : null,
    workspace_id: typeof workspace?.id === 'string' ? workspace.id : null,
    hosted_domain:
      typeof workspace?.hosted_domain === 'string'
        ? workspace.hosted_domain
        : null,
  }
}
