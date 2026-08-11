import type { CredentialResolution } from '../credentials.js'
import { randomUUID } from 'node:crypto'
import type { CliError, CliOptions, OutputMode } from '../types.js'
import { isProfileCredentialSource } from '../types.js'
import { apiPostPublic, baseUrlOf, requestConfig } from '../api.js'
import {
  authDeniedError,
  authRequiredWithDeviceAuthError,
  mapApiError,
  tokenStoreUnavailableError,
  validationError,
} from '../errors.js'
import { writeFailure, writeText } from '../output.js'
import {
  clearPendingDeviceAuth,
  readProfileToken,
  readPendingDeviceAuth,
  saveProfileSessionCredential,
  writePendingDeviceAuth,
} from '../token-store.js'
import {
  exchangeDeviceTokenOnce,
  performDeviceLogin,
  pendingDeviceAuthFromCode,
  requestDeviceCode,
  verifyAndStoreProfileToken,
} from './login.js'

const JSON_PENDING_AUTH_COMMANDS = new Set([
  'share',
  'update',
  'download',
  'artifacts get',
])

export function isInteractiveTerminal(mode: OutputMode): boolean {
  return !mode.json && process.stdin.isTTY === true
}

export function profileForAutoLogin(
  credential: Extract<CredentialResolution, { ok: false }>,
): string {
  return credential.source === 'none'
    ? 'default'
    : (credential.profile ?? 'default')
}

export type AutoLoginDeps = {
  performLogin?: typeof performDeviceLogin
}

export type AuthenticatedCredential = Extract<
  CredentialResolution,
  { ok: true }
>

function isPendingExpired(pending: { expires_at: string }): boolean {
  const expiresAt = Date.parse(pending.expires_at)
  return Number.isNaN(expiresAt) || expiresAt <= Date.now()
}

function authRequiredExtraDetails(error: CliError): Record<string, unknown> {
  const credentialSource = error.details?.credential_source
  return typeof credentialSource === 'string'
    ? { credential_source: credentialSource }
    : {}
}

function interactiveLoginMessage(
  credential: Extract<CredentialResolution, { ok: false }>,
): string {
  if (
    isProfileCredentialSource(credential.source) &&
    credential.error.details?.reauth_reason ===
      'profile_token_invalid_or_expired'
  ) {
    return 'Profile token expired. Starting device login to refresh...\n'
  }
  return 'Not signed in. Starting device login to continue...\n'
}

async function canAttemptProfileTokenSave(
  profile: string,
  options: CliOptions,
): Promise<boolean> {
  const stored = await readProfileToken(profile, options)
  return stored.ok || stored.reason !== 'unavailable'
}

export async function handleCredentialFailure(
  command: string,
  credential: Extract<CredentialResolution, { ok: false }>,
  options: CliOptions,
  mode: OutputMode,
  rerun: () => Promise<void>,
  isRetry = false,
  deps: AutoLoginDeps = {},
): Promise<void> {
  if (credential.error.code !== 'auth_required') {
    return writeFailure(command, credential.error, mode, 1)
  }

  if (mode.json && JSON_PENDING_AUTH_COMMANDS.has(command) && !isRetry) {
    return handleJsonPendingAuth(command, credential, options, mode, rerun)
  }

  if (!isInteractiveTerminal(mode) || isRetry) {
    return writeFailure(command, credential.error, mode, 1)
  }

  const performLogin = deps.performLogin ?? performDeviceLogin
  const profile = profileForAutoLogin(credential)
  writeText(interactiveLoginMessage(credential))

  const loginResult = await performLogin(profile, options, mode)
  if (!loginResult.ok) {
    return writeFailure(command, loginResult.error, mode, 1)
  }

  return rerun()
}

export async function handleAuthenticatedCredentialFailure(
  command: string,
  error: CliError,
  credential: AuthenticatedCredential,
  options: CliOptions,
  mode: OutputMode,
  rerun: () => Promise<void>,
  isRetry = false,
): Promise<void> {
  const refreshed = await refreshAuthenticatedCredential(
    error,
    credential,
    options,
    isRetry,
  )
  if (refreshed.ok) return rerun()
  if (refreshed.error) return writeFailure(command, refreshed.error, mode, 1)
  return await handleCredentialFailure(
    command,
    {
      ok: false,
      source: credential.source,
      ...(credential.profile ? { profile: credential.profile } : {}),
      error,
    },
    options,
    mode,
    rerun,
    isRetry,
  )
}

export async function refreshAuthenticatedCredential(
  error: CliError,
  credential: AuthenticatedCredential,
  options: CliOptions,
  isRetry = false,
): Promise<
  | { ok: true; credential: AuthenticatedCredential }
  | { ok: false; error?: CliError }
> {
  if (error.code !== 'auth_required') {
    return { ok: false, error }
  }
  if (
    isRetry ||
    !credential.profile ||
    credential.profileCredentialKind !== 'session' ||
    !credential.refreshToken
  ) {
    return { ok: false }
  }
  const refreshed = await refreshStoredProfileSession(
    credential.profile,
    credential.refreshToken,
    options,
  )
  if (!refreshed.ok) return refreshed
  return {
    ok: true,
    credential: {
      ...credential,
      token: refreshed.token,
    },
  }
}

export async function runAuthenticatedApi<T>(
  credential: AuthenticatedCredential,
  options: CliOptions,
  request: (
    credential: AuthenticatedCredential,
  ) => Promise<{ data: T; error?: never } | { error: CliError; data?: never }>,
): Promise<
  | { data: T; error?: never }
  | {
      error: CliError
      data?: never
      originalError?: CliError
      refreshError?: CliError
    }
> {
  const first = await request(credential)
  if (!first.error) return first
  const refreshed = await refreshAuthenticatedCredential(
    first.error,
    credential,
    options,
  )
  if (!refreshed.ok) {
    return refreshed.error
      ? {
          error: first.error,
          originalError: first.error,
          refreshError: refreshed.error,
        }
      : { error: first.error }
  }
  return await request(refreshed.credential)
}

async function refreshStoredProfileSession(
  profile: string,
  refreshToken: string,
  options: CliOptions,
): Promise<{ ok: true; token: string } | { ok: false; error?: CliError }> {
  const stored = await readProfileToken(profile, options)
  if (!stored.ok || stored.credential.kind !== 'session') return { ok: false }
  const rotationRequestId =
    stored.credential.pending_rotation_id ?? randomUUID()
  if (!stored.credential.pending_rotation_id) {
    const staged = await saveProfileSessionCredential(
      profile,
      { ...stored.credential, pending_rotation_id: rotationRequestId },
      options,
    )
    if (!staged.ok)
      return { ok: false, error: tokenStoreUnavailableError(profile) }
  }
  const request = await requestConfig(options)
  if (request.error) return { ok: false, error: request.error }
  const result = await apiPostPublic(
    '/api/cli/auth/refresh',
    {
      refresh_token: refreshToken,
      rotation_request_id: rotationRequestId,
    },
    options,
    request.init,
  )
  if (result.error) return { ok: false, error: result.error }
  const { response, body } = result
  if (!response.ok) {
    if (response.status === 401) return { ok: false }
    return {
      ok: false,
      error: mapApiError(response.status, body, {
        baseUrl: baseUrlOf(options),
      }),
    }
  }
  if (
    typeof body?.access_token !== 'string' ||
    body.access_token.length === 0 ||
    body.token_type?.toLowerCase() !== 'bearer' ||
    typeof body.expires_at !== 'string' ||
    typeof body.refresh_token !== 'string' ||
    !body.refresh_token ||
    typeof body.refresh_token_expires_at !== 'string'
  ) {
    return {
      ok: false,
      error: validationError(
        'Refresh response was invalid.',
        'Run login again. If this repeats, report the response shape.',
        'service_error',
      ),
    }
  }
  const saved = await saveProfileSessionCredential(
    profile,
    {
      kind: 'session',
      session_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: body.expires_at,
      ...(stored.credential.device_id
        ? { device_id: stored.credential.device_id }
        : {}),
    },
    options,
  )
  if (!saved.ok)
    return { ok: false, error: tokenStoreUnavailableError(profile) }
  return { ok: true, token: body.access_token }
}

async function handleJsonPendingAuth(
  command: string,
  credential: Extract<CredentialResolution, { ok: false }>,
  options: CliOptions,
  mode: OutputMode,
  rerun: () => Promise<void>,
): Promise<void> {
  const profile = profileForAutoLogin(credential)
  const extraDetails = authRequiredExtraDetails(credential.error)
  const baseUrl = baseUrlOf(options)
  const request = await requestConfig(options)
  if (request.error) {
    return writeFailure(command, request.error, mode, 1)
  }
  if (!(await canAttemptProfileTokenSave(profile, options))) {
    return writeFailure(command, tokenStoreUnavailableError(profile), mode, 1)
  }

  const existing = await readPendingDeviceAuth(baseUrl, profile)
  if (existing && !isPendingExpired(existing)) {
    const exchange = await exchangeDeviceTokenOnce(
      options,
      existing.device_code,
      request.init,
    )
    if ('error' in exchange) {
      if (exchange.error.code !== 'network_failed') {
        await clearPendingDeviceAuth(baseUrl, profile)
      }
      return writeFailure(command, exchange.error, mode, 1)
    }
    if (exchange.status === 'success') {
      const stored = await verifyAndStoreProfileToken(
        profile,
        exchange.token.access_token,
        options,
        request.init,
        exchange.token.expires_in === undefined
          ? null
          : new Date(
              Date.now() + exchange.token.expires_in * 1000,
            ).toISOString(),
      )
      if (!stored.ok) {
        return writeFailure(command, stored.error, mode, 1)
      }
      await clearPendingDeviceAuth(baseUrl, profile)
      return rerun()
    }
    if (exchange.status === 'denied') {
      await clearPendingDeviceAuth(baseUrl, profile)
      return writeFailure(command, authDeniedError(profile), mode, 1)
    }
    if (exchange.status === 'expired') {
      await clearPendingDeviceAuth(baseUrl, profile)
    } else if (exchange.status === 'retry_later') {
      return writeFailure(
        command,
        authRequiredWithDeviceAuthError(baseUrl, existing, extraDetails),
        mode,
        1,
      )
    } else {
      return writeFailure(
        command,
        authRequiredWithDeviceAuthError(baseUrl, existing, extraDetails),
        mode,
        1,
      )
    }
  } else if (existing) {
    await clearPendingDeviceAuth(baseUrl, profile)
  }

  const code = await requestDeviceCode(options, request.init)
  if ('error' in code) {
    return writeFailure(command, credential.error, mode, 1)
  }

  const pending = pendingDeviceAuthFromCode(profile, options, code)
  if (!(await writePendingDeviceAuth(pending))) {
    return writeFailure(command, credential.error, mode, 1)
  }
  return writeFailure(
    command,
    authRequiredWithDeviceAuthError(baseUrl, pending, extraDetails),
    mode,
    1,
  )
}
