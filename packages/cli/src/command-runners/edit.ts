import {
  CLI_EDIT_RESPONSE_SCHEMA,
  type CliEditRequest,
  type CliEditResponse,
} from '@artifactshare/contract'
import { apiPost, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import { serviceError, validationError } from '../errors.js'
import { writeFailure, writeSuccess } from '../output.js'
import type { OutputMode, ParsedArgs } from '../types.js'
import {
  arrayOption,
  hasProjectIdHomeConflict,
  parseArtifactTarget,
} from '../shared.js'
import { runAuthenticatedApi } from './auto-login.js'

export async function runEdit(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'edit'
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL to edit.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)

  const payload = buildEditPayload(parsed)
  if (payload.error) return writeFailure(command, payload.error, mode, 1)

  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok) return writeFailure(command, credential.error, mode, 1)
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const edited = await apiPost(
        `/api/cli/shareables/${encodeURIComponent(target.artifactId)}/edit`,
        current.token,
        payload.body,
        parsed.options,
        request.init,
        {
          artifactTarget: true,
          editSettings: true,
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
          botProfile: current.botProfile,
        },
      )
      return edited.error ? { error: edited.error } : { data: edited.body }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)

  const data = parseEditData(result.data)
  if (!data) {
    return writeFailure(
      command,
      serviceError(
        'Edit succeeded but the response did not include edit data.',
      ),
      mode,
      1,
    )
  }
  writeSuccess(command, data, mode)
}

function buildEditPayload(
  parsed: ParsedArgs,
):
  | { body: CliEditRequest; error?: never }
  | { error: ReturnType<typeof validationError>; body?: never } {
  const body: CliEditRequest = {}
  let hasChange = false

  if (
    parsed.options.linkExpiresAt !== undefined &&
    parsed.options.noLinkExpiry === true
  ) {
    return {
      error: validationError(
        'Choose only one link expiry option.',
        'Pass --link-expires-at <RFC3339 UTC> or --no-link-expiry, not both.',
      ),
    }
  }

  if (parsed.options.title !== undefined) {
    body.title = parsed.options.title
    hasChange = true
  }

  if (parsed.options.visibility !== undefined) {
    const visibility = parsed.options.visibility.trim()
    if (
      visibility !== 'private' &&
      visibility !== 'workspace' &&
      visibility !== 'link'
    ) {
      return {
        error: validationError(
          '--visibility must be private, workspace, or link.',
          'Retry with --visibility private, --visibility workspace, or --visibility link.',
        ),
      }
    }
    body.visibility = visibility
    hasChange = true
  }

  if (parsed.options.linkExpiresAt !== undefined) {
    body.link_expires_at = parsed.options.linkExpiresAt
    hasChange = true
  } else if (parsed.options.noLinkExpiry === true) {
    body.link_expires_at = null
    hasChange = true
  }

  const addEmails = normalizedEmailOptions(parsed.options.grantEmail)
  if (addEmails.error) return { error: addEmails.error }
  if (parsed.options.grantEmail !== undefined) {
    body.add_emails = addEmails.values
    hasChange = true
  }

  const removeEmails = normalizedEmailOptions(parsed.options.revokeEmail)
  if (removeEmails.error) return { error: removeEmails.error }
  if (parsed.options.revokeEmail !== undefined) {
    body.remove_emails = removeEmails.values
    hasChange = true
  }

  const destinationConflict = hasProjectIdHomeConflict(parsed.options)
  if (destinationConflict) {
    return {
      error: validationError(
        'Edit destination is conflicting.',
        'Choose either --project-id <id> or --home.',
        'destination_conflict',
      ),
    }
  }
  if (parsed.options.home) {
    body.destination = 'home'
    hasChange = true
  } else if (parsed.options.projectId !== undefined) {
    const projectId = parsed.options.projectId.trim()
    if (!projectId) {
      return {
        error: validationError(
          '--project-id must not be blank.',
          'Retry with an active project id from projects list, or use --home.',
          'invalid_destination',
        ),
      }
    }
    body.destination = { project_id: projectId }
    hasChange = true
  }

  if (!hasChange) {
    return {
      error: validationError(
        'At least one edit option is required.',
        'Pass --title, --visibility, --link-expires-at, --no-link-expiry, --grant-email, --revoke-email, --project-id, or --home.',
      ),
    }
  }

  return { body }
}

function normalizedEmailOptions(
  value: string | string[] | undefined,
):
  | { values: string[]; error?: never }
  | { error: ReturnType<typeof validationError>; values?: never } {
  const values = arrayOption(value)
    .map((email) => email.trim())
    .filter(Boolean)
  if (value !== undefined && values.length === 0) {
    return {
      error: validationError(
        'Email option must not be blank.',
        'Pass a non-empty email address.',
      ),
    }
  }
  return { values }
}

function parseEditData(body: unknown): CliEditResponse | null {
  const result = CLI_EDIT_RESPONSE_SCHEMA.safeParse(body)
  if (!result.success) return null
  return {
    ...result.data,
    artifact: {
      ...result.data.artifact,
      url: result.data.artifact.url ?? null,
    },
    share: {
      ...result.data.share,
      link_expires_at: result.data.share.link_expires_at ?? null,
    },
  }
}
