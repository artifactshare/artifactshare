import { stat } from 'node:fs/promises'
import type { CliError, CliOptions, OutputMode, ParsedArgs } from '../types.js'
import { apiUrl, baseUrlOf, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import {
  destinationConflictError,
  resolveProjectConfig,
  resolveDefaultVisibility,
  resolveSharedProjectConfig,
  resolveDestination,
} from '../destination.js'
import {
  projectAmbiguousError,
  projectNotFoundByNameError,
  type ProjectNameCandidate,
  validationError,
} from '../errors.js'
import { createUploadForm, prepareUploadPayload } from '../files.js'
import { postShareUpload } from '../share-upload.js'
import {
  handleAuthenticatedCredentialFailure,
  handleCredentialFailure,
} from './auto-login.js'
import { writeFailure, writeSuccess } from '../output.js'
import { fetchProjects } from './projects.js'
import { arrayOption } from '../shared.js'
import { nonEmpty } from '../validators.js'

// Mirrors ARTIFACT_KEY_MAX_LENGTH in apps/web/app/services/artifact-keys.server.ts;
// the CLI ships separately, so the limit is duplicated for pre-validation.
const MAX_SHARE_KEY_LENGTH = 128

export async function runShare(
  parsed: ParsedArgs,
  mode: OutputMode,
  isRetry = false,
): Promise<void> {
  const command = 'share'
  const targetPath = parsed.positionals[0]
  if (!targetPath) {
    return writeFailure(
      command,
      validationError(
        'Path is required.',
        'Pass a file or directory to share.',
      ),
      mode,
      1,
    )
  }
  if (
    parsed.options.linkExpiresAt !== undefined &&
    parsed.options.noLinkExpiry === true
  ) {
    return writeFailure(
      command,
      validationError(
        'Choose only one link expiry option.',
        'Pass --link-expires-at <RFC3339 UTC> or --no-link-expiry, not both.',
      ),
      mode,
      1,
    )
  }
  let shareKey: string | null = null
  if ('key' in parsed.options) {
    const raw = typeof parsed.options.key === 'string' ? parsed.options.key : ''
    shareKey = raw.trim()
    if (shareKey.length === 0 || shareKey.length > MAX_SHARE_KEY_LENGTH) {
      return writeFailure(
        command,
        validationError(
          `--key must be 1-${MAX_SHARE_KEY_LENGTH} characters after trimming.`,
          'Pass a short stable identifier, like a job name or PR number.',
        ),
        mode,
        1,
      )
    }
  }

  const project = await resolveProjectConfig()
  const credential = await resolveCredential(parsed.options, project)
  if (!credential.ok) {
    return handleCredentialFailure(
      command,
      credential,
      parsed.options,
      mode,
      () => runShare(parsed, mode, true),
      isRetry,
    )
  }

  const baseUrl = baseUrlOf(parsed.options)

  const hasProjectFlag = 'project' in parsed.options
  let destinationOptions: CliOptions = parsed.options
  let projectName: string | undefined

  if (hasProjectFlag) {
    projectName = nonEmpty(
      typeof parsed.options.project === 'string' ? parsed.options.project : '',
    )
    if (!projectName) {
      return writeFailure(
        command,
        validationError(
          '--project requires a value.',
          'Pass --project <name> and retry.',
        ),
        mode,
        1,
      )
    }
    const conflict = destinationConflictError(parsed.options)
    if (conflict) return writeFailure(command, conflict, mode, 1)
  } else {
    const earlyDestination = resolveDestination(parsed.options, project.config)
    if (earlyDestination.error)
      return writeFailure(command, earlyDestination.error, mode, 1)
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

  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  if (hasProjectFlag && projectName) {
    const resolved = await resolveProjectIdByName(
      projectName,
      credential.token,
      parsed.options,
      request.init,
      {
        authenticated: true,
        baseUrl,
        credentialSource: credential.source,
        profile: credential.profile,
        profileCredentialKind: credential.profileCredentialKind,
        botProfile: credential.botProfile,
      },
    )
    if (resolved.error) {
      return handleAuthenticatedCredentialFailure(
        command,
        resolved.error,
        credential,
        parsed.options,
        mode,
        () => runShare(parsed, mode, true),
        isRetry,
      )
    }
    const { project: _project, ...rest } = parsed.options
    destinationOptions = { ...rest, projectId: resolved.projectId }
  }

  const destination = resolveDestination(destinationOptions, project.config)
  if (destination.error)
    return writeFailure(command, destination.error, mode, 1)

  const initialForm = await createUploadForm()
  const grantEmails = arrayOption(parsed.options.grantEmail)
  const defaultVisibility =
    parsed.options.visibility || destination.containerId
      ? null
      : await resolveDefaultVisibility(
          'home_audience',
          await resolveSharedProjectConfig(),
        )
  if (defaultVisibility && 'error' in defaultVisibility) {
    return writeFailure(command, defaultVisibility.error, mode, 1)
  }
  const requestedVisibility =
    parsed.options.visibility ??
    (destination.containerId ? 'project' : defaultVisibility!.value)
  initialForm.set('visibility', requestedVisibility)
  for (const email of grantEmails) {
    initialForm.append('grant_email', email)
  }
  if (destination.containerId) {
    initialForm.set('container_id', destination.containerId)
  }
  if (parsed.options.linkExpiresAt !== undefined) {
    initialForm.set('link_expires_at', parsed.options.linkExpiresAt)
  } else if (parsed.options.noLinkExpiry === true) {
    initialForm.set('link_expires_at', 'null')
  }
  if (parsed.options.noSlackNotify === true) {
    initialForm.set('slack_notify', 'false')
  }

  const uploadUrl = apiUrl('/api/shareables/uploads', baseUrl)
  if (shareKey !== null) {
    uploadUrl.searchParams.set('publish_key', shareKey)
  }
  if (parsed.options.expectedVersion) {
    uploadUrl.searchParams.set(
      'expected_version',
      parsed.options.expectedVersion,
    )
  }
  const upload = await prepareUploadPayload(targetPath, fileStat, initialForm)
  if (upload.error) return writeFailure(command, upload.error, mode, 1)
  if (upload.payload.kind === 'static_site') {
    uploadUrl.searchParams.set('artifact_kind', 'static_site')
    if (destination.containerId) {
      uploadUrl.searchParams.set('container_id', destination.containerId)
    }
  }

  const uploaded = await postShareUpload(
    {
      uploadUrl,
      token: credential.token,
      form: upload.payload.form,
      requestInit: request.init,
      errorOptions: {
        authenticated: true,
        baseUrl,
        credentialSource: credential.source,
        profile: credential.profile,
        profileCredentialKind: credential.profileCredentialKind,
        botProfile: credential.botProfile,
      },
    },
    baseUrl,
    upload.payload.kind,
  )
  if ('error' in uploaded) {
    if (uploaded.error.code === 'network_failed') {
      return writeFailure(command, uploaded.error, mode, 1)
    }
    return handleAuthenticatedCredentialFailure(
      command,
      uploaded.error,
      credential,
      parsed.options,
      mode,
      () => runShare(parsed, mode, true),
      isRetry,
    )
  }

  const {
    id,
    url,
    versionId,
    artifactKind,
    visibility,
    linkExpiresAt,
    created,
    warnings,
  } = uploaded.body
  return writeSuccess(
    command,
    {
      artifact: {
        id,
        url,
        kind: artifactKind,
      },
      version: {
        id: versionId,
      },
      result: { created },
      ...(shareKey !== null ? { key: shareKey } : {}),
      destination: destination.containerId
        ? { type: 'project', project_id: destination.containerId }
        : { type: 'home' },
      share: {
        // The server may adjust the stored visibility for the destination, so
        // report its confirmed value over the requested one.
        visibility: visibility ?? requestedVisibility,
        grant_emails: grantEmails,
        link_expires_at: linkExpiresAt,
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    },
    mode,
  )
}

async function resolveProjectIdByName(
  projectName: string,
  token: string,
  options: CliOptions,
  init: Parameters<typeof fetchProjects>[2],
  errorOptions: Parameters<typeof fetchProjects>[3],
): Promise<
  { projectId: string; error?: never } | { error: CliError; projectId?: never }
> {
  const result = await fetchProjects(token, options, init, errorOptions)
  if (result.error) return { error: result.error }

  const candidates: ProjectNameCandidate[] = result.projects.flatMap(
    (project) => {
      if (project.name !== projectName) return []
      return [
        {
          project_id: project.id,
          name: project.name,
          updated_at: project.updated_at,
        },
      ]
    },
  )

  if (candidates.length === 0) return { error: projectNotFoundByNameError() }
  if (candidates.length > 1) return { error: projectAmbiguousError(candidates) }
  return { projectId: candidates[0]!.project_id }
}
