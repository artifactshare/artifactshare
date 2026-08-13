import type { OutputMode, ParsedArgs } from '../types.js'
import { apiDelete, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import { serviceError } from '../errors.js'
import { deleteSuccessFields, writeFailure, writeSuccess } from '../output.js'
import { parseArtifactTarget } from '../shared.js'
import { runAuthenticatedApi } from './auto-login.js'

export async function runDelete(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'delete'
  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL to delete.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)
  const artifactId = target.artifactId

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
      const deleted = await apiDelete(
        `/api/cli/artifacts/${encodeURIComponent(artifactId)}`,
        current.token,
        parsed.options,
        request.init,
        {
          authenticated: true,
          artifactTarget: true,
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
          botProfile: current.botProfile,
        },
      )
      return deleted.error ? { error: deleted.error } : { data: deleted.body }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)
  const body = result.data
  if (!deleteSuccessFields(body)) {
    return writeFailure(
      command,
      serviceError(
        'Delete succeeded but the response did not include deletion metadata.',
      ),
      mode,
      1,
    )
  }
  return writeSuccess(command, body, mode)
}
