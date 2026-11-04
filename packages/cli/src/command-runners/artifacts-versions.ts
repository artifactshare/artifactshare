import { apiUrl, baseUrlOf, cliFetch, readJson, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import {
  mapApiError,
  networkError,
  serviceError,
  validationError,
} from '../errors.js'
import {
  artifactVersionsSuccessFields,
  writeFailure,
  writeSuccess,
} from '../output.js'
import { parseArtifactTarget } from '../shared.js'
import type { OutputMode, ParsedArgs } from '../types.js'
import {
  handleCredentialFailure,
  handleAuthenticatedCredentialFailure,
  runAuthenticatedApi,
} from './auto-login.js'

export async function runArtifactsVersions(
  parsed: ParsedArgs,
  mode: OutputMode,
  isRetry = false,
): Promise<void> {
  const command = 'artifacts versions'
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL to list versions.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)
  const cursor = parsed.options.cursor?.trim()
  if (parsed.options.cursor !== undefined && !cursor)
    return writeFailure(
      command,
      validationError(
        '--cursor must not be empty.',
        'Restart without --cursor.',
      ),
      mode,
      1,
    )
  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok) {
    if (!mode.json) return writeFailure(command, credential.error, mode, 1)
    return handleCredentialFailure(
      command,
      credential,
      parsed.options,
      mode,
      () => runArtifactsVersions(parsed, mode, true),
      isRetry,
    )
  }
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)
  const url = apiUrl(
    `/api/cli/artifacts/${encodeURIComponent(target.artifactId)}/versions`,
    baseUrlOf(parsed.options),
  )
  if (cursor) url.searchParams.set('cursor', cursor)
  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const response = await cliFetch(url, {
        headers: { Authorization: `Bearer ${current.token}` },
        ...request.init,
      })
      if ('networkError' in response)
        return { error: networkError(response.networkError) }
      const body = await readJson(response)
      if (!response.ok)
        return {
          error: mapApiError(response.status, body, {
            authenticated: true,
            artifactTarget: true,
            baseUrl: baseUrlOf(parsed.options),
            credentialSource: current.source,
            profile: current.profile,
            profileCredentialKind: current.profileCredentialKind,
            botProfile: current.botProfile,
          }),
        }
      if (!artifactVersionsSuccessFields(body))
        return {
          error: serviceError(
            'Versions response did not include history metadata.',
          ),
        }
      return { data: body }
    },
  )
  if (result.error)
    return handleAuthenticatedCredentialFailure(
      command,
      result.error,
      credential,
      parsed.options,
      mode,
      () => runArtifactsVersions(parsed, mode, true),
      isRetry,
    )
  return writeSuccess(command, result.data, mode)
}
