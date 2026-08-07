import { apiPost, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import { serviceError, validationError } from '../errors.js'
import { writeFailure, writeSuccess } from '../output.js'
import type { MoveData, OutputMode, ParsedArgs } from '../types.js'
import { isRecord } from '../validators.js'
import { hasProjectIdHomeConflict, parseArtifactTarget } from '../shared.js'
import { runAuthenticatedApi } from './auto-login.js'

export async function runMove(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'move'
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL to move.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)

  const hasProjectId = parsed.options.projectId !== undefined
  const projectId = parsed.options.projectId?.trim() ?? ''
  const home = Boolean(parsed.options.home)
  const destinationConflict = hasProjectIdHomeConflict(parsed.options)
  if (destinationConflict || (!projectId && !home)) {
    return writeFailure(
      command,
      validationError(
        'Move destination is required.',
        'Choose exactly one destination: --project-id <id> or --home.',
        destinationConflict ? 'destination_conflict' : 'invalid_destination',
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

  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const moved = await apiPost(
        `/api/cli/shareables/${encodeURIComponent(target.artifactId)}/move`,
        current.token,
        {
          destination: home ? 'home' : { project_id: projectId },
        },
        parsed.options,
        request.init,
        {
          artifactTarget: true,
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
        },
      )
      return moved.error ? { error: moved.error } : { data: moved.body }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)

  const data = parseMoveData(result.data)
  if (!data) {
    return writeFailure(
      command,
      serviceError(
        'Move succeeded but the response did not include move data.',
      ),
      mode,
      1,
    )
  }
  writeSuccess(command, data, mode)
}

function parseMoveData(body: unknown): MoveData | null {
  if (!isRecord(body)) return null
  const artifact = body.artifact
  const destination = body.destination
  const share = body.share
  if (!isRecord(artifact) || !isRecord(destination) || !isRecord(share)) {
    return null
  }
  if (
    typeof artifact.id !== 'string' ||
    typeof destination.type !== 'string' ||
    typeof share.visibility !== 'string' ||
    typeof share.project_audience_may_change !== 'boolean'
  ) {
    return null
  }
  if (destination.type === 'project') {
    if (typeof destination.project_id !== 'string') return null
    return {
      artifact: {
        id: artifact.id,
        url: typeof artifact.url === 'string' ? artifact.url : null,
      },
      destination: {
        type: 'project',
        project_id: destination.project_id,
      },
      share: {
        visibility: share.visibility,
        project_audience_may_change: share.project_audience_may_change,
      },
    }
  }
  if (destination.type === 'home' && destination.project_id === null) {
    return {
      artifact: {
        id: artifact.id,
        url: typeof artifact.url === 'string' ? artifact.url : null,
      },
      destination: { type: 'home', project_id: null },
      share: {
        visibility: share.visibility,
        project_audience_may_change: share.project_audience_may_change,
      },
    }
  }
  return null
}
