import type {
  ArtifactGetData,
  CliError,
  OutputMode,
  ParsedArgs,
} from '../types.js'
import { apiUrl, baseUrlOf, cliFetch, readJson, requestConfig } from '../api.js'
import type { CredentialResolution } from '../credentials.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import {
  mapApiError,
  networkError,
  serviceError,
  validationError,
} from '../errors.js'
import {
  artifactGetSuccessFields,
  artifactsListSuccessFields,
  writeFailure,
  writeSuccess,
} from '../output.js'
import {
  hasProjectIdHomeConflict,
  parseArtifactTarget,
  parseIncludeOptions,
  parseOffsetOption,
} from '../shared.js'
import {
  handleAuthenticatedCredentialFailure,
  handleCredentialFailure,
  runAuthenticatedApi,
} from './auto-login.js'

export type ArtifactReadTarget = {
  artifactId: string
  include: string[]
  offset: string | undefined
}

export async function runArtifactsGet(
  parsed: ParsedArgs,
  mode: OutputMode,
  isRetry = false,
): Promise<void> {
  const command = 'artifacts get'
  const target = parseArtifactReadTarget(parsed, command)
  if (target.error) return writeFailure(command, target.error, mode, 1)
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
      () => runArtifactsGet(parsed, mode, true),
      isRetry,
    )
  }
  const result = await fetchArtifact(parsed, target.value, credential)
  if (result.error) {
    return handleAuthenticatedCredentialFailure(
      command,
      result.error,
      credential,
      parsed.options,
      mode,
      () => runArtifactsGet(parsed, mode, true),
      isRetry,
    )
  }
  return writeSuccess(command, result.data, mode)
}

export async function readArtifact(
  parsed: ParsedArgs,
  command: 'artifacts get' | 'open',
): Promise<{ data: ArtifactGetData; error?: never } | { error: CliError }> {
  const target = parseArtifactReadTarget(parsed, command)
  if (target.error) return { error: target.error }
  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok) return { error: credential.error }
  return await fetchArtifact(parsed, target.value, credential)
}

function parseArtifactReadTarget(
  parsed: ParsedArgs,
  command: 'artifacts get' | 'open',
):
  | { value: ArtifactReadTarget; error?: never }
  | { error: CliError; value?: never } {
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL to read.',
  )
  if (target.error) return { error: target.error }
  const artifactId = target.artifactId

  const offset = parseOffsetOption(parsed.options.offset)
  if (offset.error) return { error: offset.error }
  const include = parseIncludeOptions(parsed.options.include)
  if (include.error) return { error: include.error }

  return {
    value: {
      artifactId,
      include: include.values,
      offset: offset.value,
    },
  }
}

export async function fetchArtifact(
  parsed: ParsedArgs,
  target: ArtifactReadTarget,
  credential: Extract<CredentialResolution, { ok: true }>,
): Promise<{ data: ArtifactGetData; error?: never } | { error: CliError }> {
  const request = await requestConfig(parsed.options)
  if (request.error) return { error: request.error }

  const url = apiUrl(
    `/api/cli/artifacts/${encodeURIComponent(target.artifactId)}`,
    baseUrlOf(parsed.options),
  )
  if (target.offset !== undefined) url.searchParams.set('offset', target.offset)
  for (const item of target.include) {
    url.searchParams.append('include', item)
  }
  const response = await cliFetch(url, {
    headers: { Authorization: `Bearer ${credential.token}` },
    ...request.init,
  })
  if ('networkError' in response) {
    return { error: networkError(response.networkError) }
  }

  const body = await readJson(response)
  if (!response.ok) {
    return {
      error: mapApiError(response.status, body, {
        authenticated: true,
        artifactTarget: true,
        baseUrl: baseUrlOf(parsed.options),
        credentialSource: credential.source,
        profile: credential.profile,
        profileCredentialKind: credential.profileCredentialKind,
      }),
    }
  }
  if (!artifactGetSuccessFields(body)) {
    return {
      error: serviceError(
        'Artifact read succeeded but the response did not include source metadata.',
      ),
    }
  }
  return { data: body }
}

export async function runArtifactsList(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'artifacts list'
  const hasProjectId = parsed.options.projectId !== undefined
  const projectId = parsed.options.projectId?.trim() ?? ''
  const home = Boolean(parsed.options.home)
  if (hasProjectId && !projectId) {
    return writeFailure(
      command,
      validationError(
        '--project-id must not be empty.',
        'Pass --project-id <id>, use --home, or omit the destination filter.',
      ),
      mode,
      1,
    )
  }
  if (hasProjectIdHomeConflict(parsed.options)) {
    return writeFailure(
      command,
      validationError(
        'Artifact list destination is ambiguous.',
        'Choose only one destination filter: --project-id <id> or --home.',
        'destination_conflict',
      ),
      mode,
      1,
    )
  }
  const query = parsed.options.query?.trim()
  if (parsed.options.query !== undefined && !query) {
    return writeFailure(
      command,
      validationError(
        '--query must not be empty.',
        'Pass --query <text> or omit --query.',
      ),
      mode,
      1,
    )
  }

  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok) return writeFailure(command, credential.error, mode, 1)
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const url = apiUrl('/api/cli/artifacts', baseUrlOf(parsed.options))
  if (home) url.searchParams.set('project_id', '')
  else if (projectId) url.searchParams.set('project_id', projectId)
  if (query) url.searchParams.set('query', query)
  if (parsed.options.cursor?.trim()) {
    url.searchParams.set('cursor', parsed.options.cursor.trim())
  }

  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const response = await cliFetch(url, {
        headers: { Authorization: `Bearer ${current.token}` },
        ...request.init,
      })
      if ('networkError' in response) {
        return { error: networkError(response.networkError) }
      }
      const body = await readJson(response)
      if (!response.ok) {
        return {
          error: mapApiError(response.status, body, {
            authenticated: true,
            baseUrl: baseUrlOf(parsed.options),
            credentialSource: current.source,
            profile: current.profile,
            profileCredentialKind: current.profileCredentialKind,
          }),
        }
      }
      return { data: body }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)
  const body = result.data
  if (!artifactsListSuccessFields(body)) {
    return writeFailure(
      command,
      serviceError(
        'Artifact list succeeded but the response did not include list metadata.',
      ),
      mode,
      1,
    )
  }
  return writeSuccess(command, body, mode)
}
