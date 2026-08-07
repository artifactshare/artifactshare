import { agentDownloadCommand } from '../constants.js'
import type { OpenData, OutputMode, ParsedArgs } from '../types.js'
import { writeFailure, writeSuccess } from '../output.js'
import { parseArtifactTarget } from '../shared.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import { fetchArtifact } from './artifacts-get.js'
import {
  handleAuthenticatedCredentialFailure,
  handleCredentialFailure,
} from './auto-login.js'
import { ensureSkills } from './skills.js'

export async function runOpen(
  parsed: ParsedArgs,
  mode: OutputMode,
  isRetry = false,
): Promise<void> {
  const command = 'open'
  const skills = await ensureSkills(
    {
      ...parsed,
      options: {
        ...parsed.options,
        tool: 'auto',
      },
    },
    mode,
    {
      command,
      autoUpdateUserManaged: true,
      skipBrokenUserSkills: true,
    },
  )
  if (!skills) return

  const target = parseArtifactTarget(
    parsed.positionals[0],
    command,
    'Pass an artifact ID or share URL to read.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)

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
      () => runOpen(parsed, mode, true),
      isRetry,
    )
  }

  const result = await fetchArtifact(
    parsed,
    { artifactId: target.artifactId, include: [], offset: undefined },
    credential,
  )
  if (result.error) {
    if (result.error.code === 'unsupported_kind') {
      const data: OpenData = {
        skills,
        open: {
          kind: 'download_required',
          next_command: agentDownloadCommand(target.artifactId),
        },
      }
      return writeSuccess(command, data, mode)
    }
    if (result.error.code === 'auth_required') {
      return handleAuthenticatedCredentialFailure(
        command,
        result.error,
        credential,
        parsed.options,
        mode,
        () => runOpen(parsed, mode, true),
        isRetry,
      )
    }
    return writeFailure(command, result.error, mode, 1)
  }

  const data: OpenData = {
    skills,
    open: {
      kind: 'read',
      artifact: result.data,
    },
  }
  return writeSuccess(command, data, mode)
}
