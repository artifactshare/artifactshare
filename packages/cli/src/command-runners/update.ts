import { stat } from 'node:fs/promises'
import type { OutputMode, ParsedArgs } from '../types.js'
import { apiUrl, baseUrlOf, cliFetch, readJson, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import {
  mapApiError,
  networkError,
  serviceError,
  validationError,
} from '../errors.js'
import { prepareUploadPayload } from '../files.js'
import {
  handleAuthenticatedCredentialFailure,
  handleCredentialFailure,
} from './auto-login.js'
import { updateSuccessFields, writeFailure, writeSuccess } from '../output.js'
import {
  resolveArtifactId,
  targetResolutionError,
  unsupportedUpdateOption,
} from '../shared.js'

export async function runUpdate(
  parsed: ParsedArgs,
  mode: OutputMode,
  isRetry = false,
): Promise<void> {
  const command = 'update'
  const artifactInput = parsed.positionals[0]
  const targetPath = parsed.positionals[1]
  if (!artifactInput) {
    return writeFailure(
      command,
      validationError(
        'Artifact is required.',
        'Pass an artifact ID or share URL to update.',
      ),
      mode,
      1,
    )
  }
  if (!targetPath) {
    return writeFailure(
      command,
      validationError(
        'Path is required.',
        'Pass a file or directory to add as the new version.',
      ),
      mode,
      1,
    )
  }
  const unsupportedOption = unsupportedUpdateOption(parsed.options)
  if (unsupportedOption) {
    return writeFailure(
      command,
      validationError(
        `Update does not accept --${unsupportedOption}.`,
        'Update only adds a new version. Remove unsupported options and retry.',
      ),
      mode,
      1,
    )
  }
  const artifactId = resolveArtifactId(artifactInput)
  if (!artifactId) {
    return writeFailure(
      command,
      targetResolutionError(artifactInput, 'update'),
      mode,
      1,
    )
  }

  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok) {
    return handleCredentialFailure(
      command,
      credential,
      parsed.options,
      mode,
      () => runUpdate(parsed, mode, true),
      isRetry,
    )
  }

  const fileStat = await stat(targetPath).catch(() => null)
  if (!fileStat) {
    return writeFailure(
      command,
      validationError(
        'Path was not found.',
        `Check the path and retry: ${targetPath}`,
      ),
      mode,
      1,
    )
  }

  const baseUrl = baseUrlOf(parsed.options)
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const upload = await prepareUploadPayload(targetPath, fileStat)
  if (upload.error) return writeFailure(command, upload.error, mode, 1)

  const updateUrl = apiUrl(
    `/api/shareables/${encodeURIComponent(artifactId)}/versions`,
    baseUrl,
  )
  if (upload.payload.kind === 'static_site') {
    updateUrl.searchParams.set('artifact_kind', 'static_site')
  }
  if (parsed.options.expectedVersion) {
    updateUrl.searchParams.set(
      'expected_version',
      parsed.options.expectedVersion,
    )
  }

  const response = await cliFetch(updateUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${credential.token}` },
    body: upload.payload.form,
    ...request.init,
  })

  if ('networkError' in response) {
    return writeFailure(command, networkError(response.networkError), mode, 1)
  }

  const body = await readJson(response)
  if (!response.ok) {
    return handleAuthenticatedCredentialFailure(
      command,
      mapApiError(response.status, body, {
        authenticated: true,
        artifactTarget: true,
        operation: 'update',
        baseUrl,
        credentialSource: credential.source,
        profile: credential.profile,
        profileCredentialKind: credential.profileCredentialKind,
        botProfile: credential.botProfile,
      }),
      credential,
      parsed.options,
      mode,
      () => runUpdate(parsed, mode, true),
      isRetry,
    )
  }

  const id = body?.id ?? artifactId
  const url =
    body?.shareUrl ?? (id ? `${baseUrl.replace(/\/$/, '')}/a/${id}` : null)
  const artifactKind = body?.artifactKind ?? upload.payload.kind
  const result = {
    artifact: {
      id,
      url,
      kind: artifactKind,
    },
    version: {
      id: body?.versionId ?? null,
    },
    result: { updated: true },
  }
  if (!updateSuccessFields(result)) {
    return writeFailure(
      command,
      serviceError(
        'Update succeeded but the response did not include an artifact id, URL, and version id.',
      ),
      mode,
      1,
    )
  }
  return writeSuccess(command, result, mode)
}
