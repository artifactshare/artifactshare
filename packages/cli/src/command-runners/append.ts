import { stat, readFile } from 'node:fs/promises'
import type { OutputMode, ParsedArgs } from '../types.js'
import { apiUrl, baseUrlOf, cliFetch, readJson, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import {
  appendOutcomeUnknownError,
  mapApiError,
  validationError,
} from '../errors.js'
import {
  handleAuthenticatedCredentialFailure,
  handleCredentialFailure,
} from './auto-login.js'
import { updateSuccessFields, writeFailure, writeSuccess } from '../output.js'
import { resolveArtifactId, targetResolutionError } from '../shared.js'

export async function runAppend(
  parsed: ParsedArgs,
  mode: OutputMode,
  isRetry = false,
): Promise<void> {
  const command = 'append'
  const input = parsed.positionals[0]
  const path = parsed.positionals[1]
  if (!input)
    return writeFailure(
      command,
      validationError(
        'Artifact is required.',
        'Pass an artifact ID or share URL.',
      ),
      mode,
      1,
    )
  if (!path)
    return writeFailure(
      command,
      validationError('Path is required.', 'Pass a non-empty UTF-8 file.'),
      mode,
      1,
    )
  const id = resolveArtifactId(input)
  if (!id)
    return writeFailure(
      command,
      targetResolutionError(input, 'append'),
      mode,
      1,
    )
  const s = await stat(path).catch(() => null)
  if (!s || !s.isFile() || s.size === 0)
    return writeFailure(
      command,
      validationError(
        'Path must be a non-empty file.',
        'Append supports one non-empty UTF-8 file for Markdown or HTML artifacts.',
      ),
      mode,
      1,
    )
  const bytes = await readFile(path)
  let content: string
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return writeFailure(
      command,
      validationError(
        'File is not valid UTF-8.',
        'Use a non-empty UTF-8 file and retry.',
      ),
      mode,
      1,
    )
  }
  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok)
    return handleCredentialFailure(
      command,
      credential,
      parsed.options,
      mode,
      () => runAppend(parsed, mode, true),
      isRetry,
    )
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)
  const response = await cliFetch(
    apiUrl(
      `/api/cli/artifacts/${encodeURIComponent(id)}/append`,
      baseUrlOf(parsed.options),
    ),
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credential.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ content }),
      ...request.init,
    },
  )
  if ('networkError' in response)
    return writeFailure(
      command,
      appendOutcomeUnknownError(id, response.networkError),
      mode,
      1,
    )
  const body = await readJson(response)
  if (!response.ok)
    return handleAuthenticatedCredentialFailure(
      command,
      mapApiError(response.status, body, {
        authenticated: true,
        artifactTarget: true,
        operation: 'append',
        baseUrl: baseUrlOf(parsed.options),
        credentialSource: credential.source,
        profile: credential.profile,
        profileCredentialKind: credential.profileCredentialKind,
        botProfile: credential.botProfile,
      }),
      credential,
      parsed.options,
      mode,
      () => runAppend(parsed, mode, true),
      isRetry,
    )
  const success = {
    artifact: {
      id: body?.id ?? id,
      url: body?.shareUrl ?? `${baseUrlOf(parsed.options)}/a/${id}`,
      kind: body?.artifactKind,
    },
    version: { id: body?.versionId },
    result: { appended: true },
  }
  if (!updateSuccessFields(success))
    return writeFailure(
      command,
      validationError(
        'Append succeeded but the response was incomplete.',
        'Retry the command.',
      ),
      mode,
      1,
    )
  return writeSuccess(command, success, mode)
}
