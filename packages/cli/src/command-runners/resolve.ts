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
import { resolveSuccessFields, writeFailure, writeSuccess } from '../output.js'
import { runAuthenticatedApi } from './auto-login.js'

export async function runResolve(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'resolve'
  const value = parsed.positionals[0]?.trim()
  if (!value) {
    return writeFailure(
      command,
      validationError(
        'Resolve value is required.',
        'Pass a URL, ID, title, or project name to resolve.',
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

  const url = apiUrl('/api/cli/resolve', baseUrlOf(parsed.options))
  url.searchParams.set('q', value)
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
            botProfile: current.botProfile,
          }),
        }
      }
      return { data: body }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)
  const body = result.data
  if (!resolveSuccessFields(body)) {
    return writeFailure(
      command,
      serviceError(
        'Resolve succeeded but the response did not include query, candidates, and has_more.',
      ),
      mode,
      1,
    )
  }
  return writeSuccess(command, body, mode)
}
