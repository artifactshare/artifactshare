import {
  CLI_MOVE_RESPONSE_SCHEMA,
  type CliMoveRequest,
  type CliMoveResponse,
} from '@artifactshare/contract'
import { apiPost, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import { serviceError, validationError } from '../errors.js'
import { writeFailure, writeSuccess } from '../output.js'
import type { OutputMode, ParsedArgs } from '../types.js'
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
        buildMovePayload(home, projectId),
        parsed.options,
        request.init,
        {
          artifactTarget: true,
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
          botProfile: current.botProfile,
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

function buildMovePayload(home: boolean, projectId: string): CliMoveRequest {
  const payload: CliMoveRequest = {
    destination: home ? 'home' : { project_id: projectId },
  }
  return payload
}

function parseMoveData(body: unknown): CliMoveResponse | null {
  const result = CLI_MOVE_RESPONSE_SCHEMA.safeParse(body)
  if (!result.success) return null
  return {
    ...result.data,
    artifact: {
      ...result.data.artifact,
      url: result.data.artifact.url ?? null,
    },
  }
}
