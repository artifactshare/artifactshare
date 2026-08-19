import {
  CLI_INVOCATION,
  DEFAULT_BASE_URL,
  TOKEN_ENV_VAR,
  TOKEN_OPTION,
} from './constants.js'
import type {
  ApiBody,
  ApiErrorOptions,
  AuthRecoveryData,
  CliError,
  CliErrorArgs,
  DeviceAuthErrorDetails,
  PendingDeviceAuth,
  ProfileCredentialSource,
} from './types.js'
import { isProfileCredentialSource } from './types.js'
import { isRecord } from './validators.js'

const PROJECTS_LIST_COMMAND = `${CLI_INVOCATION} projects list --json`

export type ProjectNameCandidate = {
  project_id: string
  name: string | null
  updated_at: string | null
}

function apiError(body: ApiBody | null): {
  code: string | null
  message: string | undefined
} {
  const error = body?.error
  if (typeof error === 'string') return { code: error, message: undefined }
  return {
    code: normalizeApiCode(error?.code),
    message: error?.message,
  }
}

export function mapApiError(
  status: number,
  body: ApiBody | null,
  options: ApiErrorOptions = {},
): CliError {
  const { code: apiCode, message: apiMessage } = apiError(body)
  if (status === 401) {
    if (!options.authenticated) {
      return authRequiredError(options.baseUrl ?? DEFAULT_BASE_URL)
    }
    const source = options.credentialSource
    const profile = options.profile
    if (
      typeof profile === 'string' &&
      profile.length > 0 &&
      isProfileCredentialSource(source) &&
      options.profileCredentialKind !== 'api_token'
    ) {
      // Bot profiles cannot log in, use presets, or issue API tokens: the
      // only recovery is a freshly reissued bot token from a workspace admin.
      if (options.botProfile) {
        return botReauthRequiredError(profile)
      }
      return profileReauthRequiredError(
        options.baseUrl ?? DEFAULT_BASE_URL,
        source,
        profile,
      )
    }
    return tokenInvalidError()
  }
  if (apiCode === 'upload-not-allowed') {
    return cliError({
      code: 'upload_not_allowed',
      message: 'Sharing is temporarily unavailable.',
      why: 'Artifact Share has paused sharing for now.',
      hint: 'Contact Artifact Share support if you need sharing enabled.',
      agentRecoverable: false,
      requiresHuman: true,
      recovery: { kind: 'ask_human' },
      details: { limit: 'upload_access' },
    })
  }
  if (apiCode === 'self-upload-disabled') {
    return cliError({
      code: 'self_upload_disabled',
      message: 'This account cannot upload its own files.',
      why: 'Email-code sign-in creates a viewer workspace for shared files only.',
      hint: 'Sign in with Google or Microsoft on the Artifact Share website, then retry share.',
      agentRecoverable: false,
      requiresHuman: true,
      recovery: { kind: 'ask_human' },
      details: { limit: 'self_upload' },
    })
  }
  if (apiCode === 'workspace-access-revoked') {
    return cliError({
      code: 'workspace_access_revoked',
      message: apiMessage ?? 'Your access to this workspace has been revoked.',
      why: 'Artifact Share revoked this account’s workspace membership.',
      hint: 'Ask a workspace administrator to restore membership, then retry share.',
      agentRecoverable: false,
      requiresHuman: true,
      recovery: { kind: 'ask_human' },
    })
  }
  if (apiCode === 'contributor-limit-exceeded') {
    return cliError({
      code: 'contributor_limit_exceeded',
      message:
        apiMessage ??
        'This workspace cannot add more contributors. Contact the Artifact Share team.',
      why: 'This workspace cannot add more contributors.',
      hint: 'Contact the Artifact Share team, then retry.',
      agentRecoverable: false,
      requiresHuman: true,
      recovery: { kind: 'ask_human' },
    })
  }
  if (apiCode === 'quota-exceeded') {
    const apiDetails =
      typeof body?.error === 'object' && isRecord(body.error.details)
        ? body.error.details
        : undefined
    const upgradeRequest = isRecord(apiDetails?.upgrade_request)
      ? apiDetails.upgrade_request
      : undefined
    return cliError({
      code: 'storage_limit_exceeded',
      message: 'Storage quota is exceeded.',
      why: 'The workspace does not have enough remaining storage for this upload.',
      hint: 'Reduce the artifact size or ask an administrator to increase storage.',
      agentRecoverable: false,
      requiresHuman: true,
      recovery: { kind: 'ask_human' },
      ...(upgradeRequest
        ? { details: { upgrade_request: upgradeRequest } }
        : {}),
    })
  }
  if (apiCode !== null && ['too-large', 'file-too-large'].includes(apiCode)) {
    return cliError({
      code: 'file_too_large',
      message: apiMessage ?? 'The upload is too large.',
      why: 'The selected file or directory exceeds the current upload limit.',
      hint: 'Reduce generated files and retry.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode === 'too-many-files') {
    return cliError({
      code: 'file_count_exceeded',
      message: apiMessage ?? 'Too many files in the static site bundle.',
      why: 'The directory exceeds the static site file count limit.',
      hint: 'Remove generated assets and retry with fewer files.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode !== null && ['invalid-container'].includes(apiCode)) {
    return cliError({
      code: 'project_not_found',
      message: apiMessage ?? 'The share destination is invalid.',
      why: 'The project ID does not exist or is not available in this workspace.',
      hint: 'Retry with a valid --project-id or use --home.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode === 'thread-not-found') {
    return cliError({
      code: 'thread_not_found',
      message: apiMessage ?? 'Comment thread was not found.',
      why: 'No comment thread with that ID exists on this artifact.',
      hint: `Run ${CLI_INVOCATION} comments list <artifact-id> --json and retry with a listed thread id.`,
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode === 'message-not-found') {
    return cliError({
      code: 'message_not_found',
      message: apiMessage ?? 'Comment message was not found.',
      why: 'No comment message with that ID exists in the selected thread.',
      hint: `Run ${CLI_INVOCATION} comments list <artifact-id> --json and retry with a listed message_id.`,
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode === 'thread-resolved') {
    return cliError({
      code: 'thread_resolved',
      message: apiMessage ?? 'Comment thread is resolved.',
      why: 'Resolved threads do not accept new replies.',
      hint: 'Reopen the thread in the viewer first, or start a new thread without --reply-to.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode === 'invalid-comment') {
    return validationError(
      apiMessage ?? 'Invalid comment payload.',
      'Check the comment body and IDs, then retry.',
    )
  }
  if (apiCode === 'quote-unsupported') {
    return cliError({
      code: 'quote_unsupported',
      message: apiMessage ?? 'This artifact does not support quoted comments.',
      why: 'Quoted-text comments work only on single-file Markdown or HTML artifacts.',
      hint: 'Retry without --quote to comment on the whole artifact.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode === 'quote-not-found') {
    return cliError({
      code: 'quote_not_found',
      message: apiMessage ?? 'The quoted text was not found in the artifact.',
      why: 'The --quote value must match the artifact text exactly.',
      hint: `Copy the exact text from ${CLI_INVOCATION} artifacts get <artifact-id>, or add --quote-before / --quote-after to pick the right occurrence.`,
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (options.artifactTarget && (apiCode === 'not-found' || status === 404)) {
    return cliError({
      code: 'target_not_found',
      message: apiMessage ?? 'Artifact target was not found.',
      why: 'The specified artifact does not exist or is not available in the current workspace.',
      hint: 'Retry with an artifact ID or share URL that this account can access.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (options.projectTarget && (apiCode === 'not-found' || status === 404)) {
    return cliError({
      code: 'target_not_found',
      message: apiMessage ?? 'Project target was not found.',
      why: 'The specified project does not exist or is not available in the current workspace.',
      hint: `Run ${PROJECTS_LIST_COMMAND}, then retry with a listed project id.`,
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'run_command', command: PROJECTS_LIST_COMMAND },
    })
  }
  if (options.artifactTarget && apiCode === 'unsupported-kind') {
    return cliError({
      code: 'unsupported_kind',
      message:
        apiMessage ?? 'This artifact cannot be read as a single source file.',
      why: 'Static sites and other multi-file artifacts do not have one Markdown or HTML source to read back.',
      hint: 'Open the share URL in a browser, or use a supported artifact kind.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (options.artifactTarget && apiCode === 'source-unavailable') {
    return cliError({
      code: 'source_unavailable',
      message: apiMessage ?? 'Artifact source is unavailable.',
      why: 'The current version exists but its stored source could not be read.',
      hint: 'Retry later. If this repeats, open the share URL and check the artifact.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'retry_later' },
    })
  }
  if (options.artifactTarget && apiCode === 'copy-forbidden') {
    const append = options.operation === 'append'
    return cliError({
      code: 'artifact_kind_mismatch',
      message:
        apiMessage ??
        (append
          ? 'Append only supports single-file Markdown or HTML artifacts.'
          : 'The selected artifact cannot be updated with this input.'),
      why: append
        ? 'Static sites do not have one source file to append to.'
        : 'Single-file artifacts must be updated with a file, and static-site artifacts must be updated with a directory.',
      hint: append
        ? 'Use update to replace the full source, or append to a single Markdown or HTML artifact.'
        : 'Retry with the same kind of input that was used to create the artifact.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (
    options.artifactTarget &&
    options.operation === 'append' &&
    apiCode === 'version_conflict'
  ) {
    const current =
      typeof body?.error === 'object' ? body.error.details : undefined
    const currentVersionId =
      isRecord(current) && typeof current.current_version_id === 'string'
        ? current.current_version_id
        : null
    return cliError({
      code: 'version_conflict',
      message: apiMessage ?? 'The artifact changed before append.',
      why: currentVersionId
        ? `The current version is ${currentVersionId}.`
        : 'Another update was committed first.',
      hint: 'Run the same append command again to append to the latest content.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'retry_later' },
      ...(currentVersionId
        ? { details: { current_version_id: currentVersionId } }
        : {}),
    })
  }
  if (apiCode === 'project-limit-reached') {
    const apiDetails =
      typeof body?.error === 'object' && isRecord(body.error.details)
        ? body.error.details
        : undefined
    const upgradeRequest = isRecord(apiDetails?.upgrade_request)
      ? apiDetails.upgrade_request
      : undefined
    return cliError({
      code: 'project_limit_reached',
      message:
        apiMessage ??
        "You've reached your plan's project limit. Upgrade your plan or archive existing projects.",
      why: 'The workspace already has the maximum number of active projects allowed by its plan.',
      hint: 'Archive an existing project, upgrade the workspace plan, or choose a different project.',
      agentRecoverable: false,
      requiresHuman: true,
      recovery: { kind: 'change_input' },
      ...(upgradeRequest
        ? { details: { upgrade_request: upgradeRequest } }
        : {}),
    })
  }
  if (apiCode === 'forbidden' || status === 403) {
    return cliError({
      code: 'forbidden',
      message: apiMessage ?? 'You do not have permission to do that.',
      why: 'The current account is not allowed to change this comment or artifact.',
      hint: 'Use an account with permission, or ask the artifact owner or a workspace admin to make the change.',
      agentRecoverable: false,
      requiresHuman: true,
      recovery: { kind: 'ask_human' },
    })
  }
  if (apiCode === 'key-target-moved') {
    return cliError({
      code: 'key_target_moved',
      message: apiMessage ?? 'The artifact for this key moved.',
      why: 'The artifact this key points to now lives in a different destination, so the key no longer updates it.',
      hint: 'Find the artifact with resolve --json, then update it by ID or share with a new key.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode === 'key-kind-mismatch') {
    return cliError({
      code: 'key_kind_mismatch',
      message: apiMessage ?? 'The artifact for this key is a different kind.',
      why: 'The key points to an artifact whose kind (single file or static site) does not match this input.',
      hint: 'Check the existing artifact by ID, or share with a new key.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode === 'key-conflict') {
    return cliError({
      code: 'key_conflict',
      message: apiMessage ?? 'Another share created this key first.',
      why: 'Two share commands raced to create the same key, and the other one won.',
      hint: 'Retry the same command; it will update the artifact the other share created.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'retry_later' },
    })
  }
  if (apiCode === 'invalid-destination') {
    return cliError({
      code: 'invalid_destination',
      message: apiMessage ?? 'The move destination is invalid.',
      why: 'The destination project does not exist, is archived, or is not available in this workspace.',
      hint: `Run ${PROJECTS_LIST_COMMAND}, then retry with --project-id <id> or --home.`,
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'run_command', command: PROJECTS_LIST_COMMAND },
    })
  }
  if (options.editSettings && apiCode === 'workspace-unavailable') {
    return cliError({
      code: 'workspace_unavailable',
      message:
        apiMessage ?? 'Workspace visibility is unavailable for this account.',
      why: 'Personal Google accounts cannot share with a whole workspace.',
      hint: 'Retry with --visibility private and explicit --grant-email values.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (
    apiCode === 'link-sharing-plan-required' ||
    apiCode === 'link-sharing-disabled' ||
    apiCode === 'link-expiry-invalid'
  ) {
    const code = apiCode.replaceAll('-', '_')
    return cliError({
      code,
      message: apiMessage ?? 'The link sharing option is invalid.',
      why:
        apiCode === 'link-sharing-plan-required'
          ? 'Link sharing is available only on Plus and Team plans.'
          : apiCode === 'link-sharing-disabled'
            ? 'The Team workspace has disabled link sharing.'
            : 'The requested link expiry does not match the link sharing policy.',
      hint:
        apiCode === 'link-expiry-invalid'
          ? 'Pass a future RFC3339 UTC timestamp within the workspace maximum, or use --no-link-expiry when unlimited expiry is allowed.'
          : 'Ask a workspace owner or administrator to review the workspace plan or link sharing policy.',
      agentRecoverable: apiCode === 'link-expiry-invalid',
      requiresHuman: apiCode !== 'link-expiry-invalid',
      recovery:
        apiCode === 'link-expiry-invalid'
          ? { kind: 'change_input' }
          : { kind: 'ask_human' },
    })
  }
  if (
    (options.editSettings || options.projectTarget) &&
    apiCode === 'too-many-grants'
  ) {
    return cliError({
      code: 'too_many_grants',
      message: apiMessage ?? 'Too many people are shared.',
      why: 'The target reached the maximum number of explicit viewers.',
      hint: 'Remove one or more viewers, or use a narrower set of email values.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (options.projectTarget && apiCode === 'project-archived') {
    return cliError({
      code: 'project_archived',
      message: apiMessage ?? 'Project is archived.',
      why: 'Archived projects must be unarchived before changing their settings or audience.',
      hint: 'Retry with --unarchive in the same command, or unarchive the project first.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (
    apiCode !== null &&
    [
      'unsupported-type',
      'invalid-key',
      'invalid-path',
      'missing-entrypoint',
      'invalid-form-data',
      'invalid-visibility',
      'invalid-grants',
      'missing-file',
      'invalid-artifact-kind',
      'unknown-artifact-kind',
      'too-many-parts',
      'workspace-unavailable',
    ].includes(apiCode)
  ) {
    return cliError({
      code: 'validation_failed',
      message: apiMessage ?? 'The upload input is invalid.',
      why: 'The file, directory, or share options failed server-side validation.',
      hint: 'Check the path, file types, and visibility options, then retry.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (status === 400) {
    return cliError({
      code: 'validation_failed',
      message: apiMessage ?? 'The request input is invalid.',
      why: 'Artifact Share rejected the request as invalid.',
      hint: 'Check the command input and retry.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'change_input' },
    })
  }
  if (apiCode === 'upload-policy-unavailable') {
    return cliError({
      code: 'service_unavailable',
      message: apiMessage ?? 'Upload permission could not be checked.',
      why: 'Artifact Share could not verify upload permission right now.',
      hint: 'Retry later with the same command.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'retry_later' },
    })
  }
  if (apiCode === 'maintenance') {
    return cliError({
      code: 'maintenance',
      message: apiMessage ?? 'Artifact Share is currently under maintenance.',
      why: 'Artifact Share is temporarily unavailable while maintenance is in progress.',
      hint: 'Retry the same command in a few minutes.',
      agentRecoverable: true,
      requiresHuman: false,
      recovery: { kind: 'retry_later' },
      details: { status },
    })
  }
  return cliError({
    code: 'service_error',
    message: apiMessage ?? `Artifact Share returned HTTP ${status}.`,
    why: `The API request failed with status ${status}.`,
    hint: 'Check the input and retry. If this repeats, report the response code.',
    agentRecoverable: status >= 500,
    requiresHuman: status >= 500 ? false : status !== 400,
    recovery: { kind: status >= 500 ? 'retry_later' : 'change_input' },
    details: { status, api_code: apiCode ?? null },
  })
}

export function serviceError(message: string): CliError {
  return cliError({
    code: 'service_error',
    message,
    why: 'Artifact Share returned a success response without required fields.',
    hint: 'Retry with --json. If this repeats, report the response.',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'retry_later' },
  })
}

export function tokensUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/settings/tokens`
}

export function authRecoveryDetails(
  baseUrl: string,
  loginCommand = `${CLI_INVOCATION} login --profile default`,
): AuthRecoveryData {
  return {
    token_url: tokensUrl(baseUrl),
    env_var: TOKEN_ENV_VAR,
    login_command: loginCommand,
    agent_login_command: `${loginCommand} --preset agent`,
    token_option: TOKEN_OPTION,
  }
}

export function authRequiredError(baseUrl: string): CliError {
  const url = tokensUrl(baseUrl)
  return cliError({
    code: 'auth_required',
    message: 'Login is required.',
    why: `No ${TOKEN_ENV_VAR} or ${TOKEN_OPTION} value was provided.`,
    hint: `With a user present, run ${CLI_INVOCATION} login --profile default; for an agent, add --preset agent. In unattended CI or scripts without browser approval, issue a token at ${url}, then set ${TOKEN_ENV_VAR} or pass ${TOKEN_OPTION}.`,
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: authRecoveryDetails(baseUrl),
  })
}

export function botReauthRequiredError(profile: string): CliError {
  return cliError({
    // Keeps 'auth_required' so the session-rotation path still fires (the
    // stored 180-day refresh token must be used before giving up); the
    // device-login fallback is blocked separately by the bot guard in
    // handleCredentialFailure via details.reauth_reason.
    code: 'auth_required',
    message: 'The bot credential is no longer valid.',
    why: `The saved bot credential for profile "${profile}" is expired, was superseded by a reissue, or the bot was stopped.`,
    hint: `If a workspace administrator already reissued the bot token, import it: printf '%s' "$TOKEN" | ${CLI_INVOCATION} profiles import-token --profile ${profile} --force. Otherwise ask a workspace administrator to reissue the bot token.`,
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: {
      profile,
      reauth_reason: 'bot_credential_invalid',
    },
  })
}

export function botTokenInvalidError(profile: string): CliError {
  return cliError({
    code: 'bot_token_invalid',
    message: 'The bot token was rejected.',
    why: 'The token is revoked (a newer reissue supersedes it), expired, or the bot was stopped.',
    hint: 'Ask a workspace administrator to reissue the bot token, then import the newly displayed token.',
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: { profile },
  })
}

export function profileReauthRequiredError(
  baseUrl: string,
  source: ProfileCredentialSource,
  profile: string,
): CliError {
  const loginCommand = `${CLI_INVOCATION} login --profile ${profile}`
  return cliError({
    code: 'auth_required',
    message: 'Login is required.',
    why: `The saved credential for profile "${profile}" is invalid or expired.`,
    hint: `With a user present, run ${loginCommand}; for an agent, add --preset agent. In unattended CI or scripts without browser approval, issue a token at ${tokensUrl(baseUrl)}, then set ${TOKEN_ENV_VAR} or pass ${TOKEN_OPTION}.`,
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: {
      ...authRecoveryDetails(baseUrl, loginCommand),
      credential_source: source,
      reauth_reason: 'profile_token_invalid_or_expired',
      profile,
    },
  })
}

export function deviceAuthErrorDetails(
  pending: PendingDeviceAuth,
): DeviceAuthErrorDetails {
  const openUrl = pending.verification_uri_complete ?? pending.verification_uri
  return {
    profile: pending.profile,
    verification_uri: pending.verification_uri,
    verification_uri_complete: pending.verification_uri_complete,
    user_code: pending.user_code,
    expires_at: pending.expires_at,
    interval_seconds: pending.interval_seconds,
    instruction: `Open ${openUrl} and enter code ${pending.user_code} to sign in.`,
    retry_hint:
      'After approval in the browser, rerun the same command to continue.',
  }
}

export function authRequiredWithDeviceAuthError(
  baseUrl: string,
  pending: PendingDeviceAuth,
  extraDetails: Record<string, unknown> = {},
): CliError {
  const device = deviceAuthErrorDetails(pending)
  const openUrl = pending.verification_uri_complete ?? pending.verification_uri
  return cliError({
    code: 'auth_required',
    message: 'Login is required.',
    why: `No ${TOKEN_ENV_VAR} or ${TOKEN_OPTION} value was provided.`,
    hint: `Open ${openUrl} and enter code ${pending.user_code}. ${device.retry_hint}`,
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: {
      ...authRecoveryDetails(
        baseUrl,
        `${CLI_INVOCATION} login --profile ${pending.profile}`,
      ),
      ...extraDetails,
      ...device,
    },
  })
}

export function tokenInvalidError(): CliError {
  return cliError({
    code: 'token_invalid',
    message: 'The bearer token is invalid or expired.',
    why: 'Artifact Share rejected the Authorization bearer token.',
    hint: `Refresh ${TOKEN_ENV_VAR} or sign in again, then retry.`,
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
  })
}

export function authDeniedError(profile: string): CliError {
  return cliError({
    code: 'auth_denied',
    message: 'Login was denied.',
    why: 'The device login request was denied in the browser.',
    hint: `Run ${CLI_INVOCATION} login --profile ${profile} again if you want to sign in.`,
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: {
      profile,
      suggested_command: `${CLI_INVOCATION} login --profile ${profile}`,
    },
  })
}

export function authExpiredError(profile: string): CliError {
  return cliError({
    code: 'auth_expired',
    message: 'Login expired.',
    why: 'The device login was not completed before the code expired.',
    hint: `Run ${CLI_INVOCATION} login --profile ${profile} again.`,
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: {
      profile,
      suggested_command: `${CLI_INVOCATION} login --profile ${profile}`,
    },
  })
}

export function authAccountMismatchError(
  profile: string,
  expectedEmail: string,
  actualEmail: string | null,
): CliError {
  const actual = actualEmail ?? 'an unknown account'
  return cliError({
    code: 'auth_account_mismatch',
    message:
      'The credential uses a different account than this profile expects.',
    why: `Profile "${profile}" is already associated with ${expectedEmail}, but the credential identifies ${actual}.`,
    hint: 'Use a credential for the expected account, or use another --profile name.',
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: {
      profile,
      expected_email: expectedEmail,
      actual_email: actualEmail,
    },
  })
}

export function profileNotFoundError(profile: string): CliError {
  return cliError({
    code: 'profile_not_found',
    message: `Profile "${profile}" was not found.`,
    why: 'No saved CLI profile has that name.',
    hint: `Run ${CLI_INVOCATION} profiles list to see saved profiles, or ${CLI_INVOCATION} login --profile ${profile} to create it.`,
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'change_input' },
    details: { profile },
  })
}

type TokenStoreFailureCause =
  | 'native_store_unavailable'
  | 'store_operation_failed'
  | 'config_write_failed'
  | 'credential_store_unavailable_or_failed'

export function tokenStoreUnavailableError(
  profile?: string,
  cause: TokenStoreFailureCause = 'credential_store_unavailable_or_failed',
  platform: NodeJS.Platform = process.platform,
): CliError {
  const hint =
    cause === 'config_write_failed'
      ? 'Check that the resolved configuration directory is private and writable, then retry.'
      : cause === 'store_operation_failed'
        ? 'Retry the credential operation. If it continues to fail, check access to the configured credential store and configuration directory.'
        : platform === 'win32'
          ? 'Windows requires Credential Manager for saved profiles. Check that Windows PowerShell 5.1 and Credential Manager are available, then retry.'
          : `Configure an OS credential store, or rerun login with --allow-plaintext-token-store only if this machine is trusted.`
  return cliError({
    code: 'token_store_unavailable',
    message: 'No safe token store is available.',
    why: 'Artifact Share could not use an OS credential store for this environment.',
    hint,
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: {
      cause,
      platform,
      ...(profile ? { profile } : {}),
    },
  })
}

export function configHomeUnavailableError(profile?: string): CliError {
  return cliError({
    code: 'config_home_unavailable',
    message: 'The user configuration directory could not be resolved.',
    why: 'Artifact Share could not resolve a home directory for profile configuration or the plaintext token fallback.',
    hint: 'Set ARTIFACTSHARE_CONFIG_HOME to a private directory owned by the current user, then retry.',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'change_input' },
    details: {
      cause: 'config_home_unresolved',
      platform: process.platform,
      ...(profile ? { profile } : {}),
    },
  })
}

export function skillUpdateConflictError(path: string): CliError {
  return cliError({
    code: 'skill_update_conflict',
    message: `The file at ${path} is not managed by Artifact Share CLI.`,
    why: 'Artifact Share only rewrites or removes skill files it created with a managed marker comment.',
    hint: 'Inspect the file and resolve it yourself, or rerun skills install --tool <tool> --force to overwrite it.',
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'ask_human' },
    details: { path },
  })
}

export function unknownCommandError(command: string): CliError {
  return cliError({
    code: 'unknown_command',
    message: `Unknown command: ${command}`,
    why: 'The command is not part of Artifact Share CLI.',
    hint: `Run ${CLI_INVOCATION} --help.`,
    agentRecoverable: true,
    requiresHuman: false,
    recovery: {
      kind: 'run_command',
      command: `${CLI_INVOCATION} --help`,
    },
  })
}

export function normalizeApiCode(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

export function uploadBlockedHint(code: string | null): string {
  if (code === 'self-upload-disabled') {
    return 'Sign in with Google or Microsoft on the Artifact Share website, then retry share.'
  }
  if (code === 'upload-not-allowed') {
    return 'Contact Artifact Share support; sharing is temporarily unavailable.'
  }
  if (code === 'upload-policy-unavailable') {
    return 'Retry doctor later; upload permission could not be checked.'
  }
  return 'Resolve the upload issue, then retry share.'
}

export function projectNotFoundByNameError(): CliError {
  return cliError({
    code: 'project_not_found',
    message: 'The share destination project was not found.',
    why: 'No project in the current workspace matches the given project name exactly.',
    hint: `Run ${PROJECTS_LIST_COMMAND}, then retry with --project-id <id>.`,
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'run_command', command: PROJECTS_LIST_COMMAND },
  })
}

export function projectAmbiguousError(
  candidates: ProjectNameCandidate[],
): CliError {
  return cliError({
    code: 'project_ambiguous',
    message: 'The share destination project is ambiguous.',
    why: 'Multiple projects in the current workspace match the given project name exactly.',
    hint: 'Retry with --project-id <id> from the candidates.',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'change_input' },
    details: { candidates },
  })
}

export function validationError(
  message: string,
  hint: string,
  code = 'validation_failed',
): CliError {
  return cliError({
    code,
    message,
    why: 'The command input is not valid.',
    hint,
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'change_input' },
  })
}

export function networkError(error: unknown): CliError {
  return cliError({
    code: 'network_failed',
    message: 'Network request failed.',
    why:
      error instanceof Error
        ? error.message
        : 'Artifact Share could not be reached.',
    hint: 'Check the base URL and network connection, then retry.',
    agentRecoverable: true,
    requiresHuman: false,
    recovery: { kind: 'retry_later' },
  })
}

export function appendOutcomeUnknownError(
  artifactId: string,
  error: unknown,
): CliError {
  return cliError({
    code: 'append_outcome_unknown',
    message: 'The append result is unknown.',
    why:
      error instanceof Error
        ? `The connection ended before confirmation: ${error.message}`
        : 'The connection ended before Artifact Share confirmed whether the append was saved.',
    hint: `Run ${CLI_INVOCATION} artifacts get ${artifactId} --json before retrying append. Inspect the source end for Markdown; for HTML, inspect immediately before the selected closing body tag, or the source end when that tag is absent.`,
    agentRecoverable: true,
    requiresHuman: false,
    recovery: {
      kind: 'run_command',
      command: `${CLI_INVOCATION} artifacts get ${artifactId} --json`,
    },
  })
}

export function unexpectedError(error: unknown): CliError {
  return cliError({
    code: 'unexpected_error',
    message: 'Unexpected error.',
    why: error instanceof Error ? error.message : String(error),
    hint: 'Retry with --json and report the error if it repeats.',
    agentRecoverable: false,
    requiresHuman: true,
    recovery: { kind: 'report_issue' },
  })
}

export function cliError(args: CliErrorArgs): CliError {
  return {
    code: args.code,
    message: args.message,
    why: args.why,
    hint: args.hint,
    agent_recoverable: args.agentRecoverable,
    requires_human: args.requiresHuman,
    recovery: args.recovery,
    ...(args.details ? { details: args.details } : {}),
  }
}
