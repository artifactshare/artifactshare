import type { OutputMode, ParsedArgs } from '../types.js'
import { apiGet, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import { writeFailure, writeSuccess } from '../output.js'
import { isRecord } from '../validators.js'
import { runAuthenticatedApi } from './auto-login.js'

export async function runWhoami(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'whoami'
  const credential = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!credential.ok) return writeFailure(command, credential.error, mode, 1)
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const whoami = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const result = await apiGet(
        '/api/cli/whoami',
        current.token,
        parsed.options,
        request.init,
        {
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
          botProfile: current.botProfile,
        },
      )
      return result.error ? { error: result.error } : { data: result.body }
    },
  )
  if (whoami.error) return writeFailure(command, whoami.error, mode, 1)
  return writeSuccess(
    command,
    isRecord(whoami.data)
      ? { ...whoami.data, credential_source: credential.source }
      : { credential_source: credential.source },
    mode,
  )
}
