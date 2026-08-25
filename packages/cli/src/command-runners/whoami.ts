import type { OutputMode, ParsedArgs } from '../types.js'
import { apiGet, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import { writeFailure, writeSuccess } from '../output.js'
import { readProfileToken } from '../token-store.js'
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
  const renewal = await renewalDetails(credential, parsed.options)
  return writeSuccess(
    command,
    isRecord(whoami.data)
      ? { ...whoami.data, credential_source: credential.source, ...renewal }
      : { credential_source: credential.source, ...renewal },
    mode,
  )
}

async function renewalDetails(
  credential: Awaited<ReturnType<typeof resolveCredential>> & { ok: true },
  options: ParsedArgs['options'],
): Promise<Record<string, unknown>> {
  if (credential.profileCredentialKind !== 'session' || !credential.profile) {
    return { renewal: { kind: 'none' } }
  }
  const stored = await readProfileToken(credential.profile, options)
  const session =
    stored.ok && stored.credential.kind === 'session' ? stored.credential : null
  return {
    session_expires_at: session?.expires_at ?? null,
    refresh_credential_expires_at:
      session?.refresh_credential_expires_at ?? null,
    renewal: {
      kind: 'automatic',
      trigger: 'session_unauthorized_once',
      ...(credential.botProfile ? { recovery: 'admin_reissue' } : {}),
    },
  }
}
