import {
  WriteBoundary,
  WriteBoundaryError,
  type WriteBoundaryDependencies,
} from '../write-boundary.js'
import { dirname, join, resolve } from 'node:path'
import {
  ARTIFACTS_LIST_RESPONSE_SCHEMA,
  isArtifactId,
} from '@artifactshare/contract'
import type { CliError, OutputMode, ParsedArgs } from '../types.js'
import {
  apiUrl,
  baseUrlOf,
  cliFetch,
  downloadFileUrl,
  readJson,
  requestConfig,
} from '../api.js'
import { resolveCredential } from '../credentials.js'
import { resolveProjectConfig } from '../destination.js'
import { mapApiError, networkError, serviceError } from '../errors.js'
import {
  DownloadManifestError,
  downloadFileSystemError,
  prepareDownloadPlan,
  verifyDownloadedBytes,
} from '../files.js'
import {
  handleAuthenticatedCredentialFailure,
  handleCredentialFailure,
  refreshAuthenticatedCredential,
} from './auto-login.js'
import {
  downloadManifestFields,
  writeFailure,
  writeSuccess,
} from '../output.js'
import { parseArtifactTarget } from '../shared.js'
import { validationError } from '../errors.js'
import { isRecord } from '../validators.js'

class DownloadFileError extends Error {}
class DownloadFailure extends Error {
  constructor(readonly error: CliError) {
    super(error.message)
  }
}

function fileDownloadError(
  error: CliError,
  path: string,
  notFound = false,
): CliError {
  const message = `Could not download file "${path}".`
  return {
    ...error,
    message: notFound ? message : `${message} ${error.message}`,
    why: notFound
      ? `The artifact manifest was retrieved, but file "${path}" could not be fetched.`
      : `File "${path}": ${error.why}`,
    hint: notFound
      ? `Retry the download. If it fails again, check file "${path}" in the artifact.`
      : `File "${path}": ${error.hint}`,
  }
}

type ProjectResult = {
  id: string
  title: string
  owner_email?: string
  updated_at: string
  share_url: string
  version_id?: string
  status: string
  path?: string
  reason?: string
}

// Previous run's id → version_id pairs from <output>/index.json, used for the
// incremental re-run. A missing or corrupt index means no previous knowledge.
function validateIds(entries: unknown[]): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    const id = isRecord(entry) ? entry.id : undefined
    if (!isArtifactId(id) || seen.has(id.toLowerCase())) {
      throw new WriteBoundaryError(
        `artifact ID ${typeof id === 'string' ? JSON.stringify(id) : '(missing or non-string)'}`,
        'Use unique artifact IDs matching ^[a-z0-9]{10}$. Correct the endpoint or saved index and retry.',
      )
    }
    seen.add(id.toLowerCase())
  }
}

async function readPreviousVersions(
  output: string,
  boundary: WriteBoundary,
): Promise<Map<string, string>> {
  const text = await boundary.read(join(output, 'index.json'))
  if (text === null) return new Map()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return new Map()
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.artifacts)) return new Map()
  validateIds(parsed.artifacts)
  const previous = new Map<string, string>()
  for (const entry of parsed.artifacts) {
    if (entry.version_id !== undefined && typeof entry.version_id !== 'string')
      return new Map()
    if (typeof entry.version_id === 'string')
      previous.set(entry.id, entry.version_id)
  }
  return previous
}

export async function runDownload(
  parsed: ParsedArgs,
  mode: OutputMode,
  isRetry = false,
  dependencies: WriteBoundaryDependencies = {},
): Promise<void> {
  const boundary = new WriteBoundary(dependencies)
  let primary: unknown
  let cleanup: unknown
  try {
    await runDownloadInternal(parsed, mode, isRetry, boundary)
  } catch (error) {
    primary = error
  }
  try {
    await boundary.cleanup()
  } catch (error) {
    cleanup = error
  }
  const error = primary ?? cleanup
  if (error) {
    const failure =
      error instanceof DownloadFailure
        ? error.error
        : downloadFileSystemError(error)
    if (primary && cleanup) failure.hint += ' Cleanup could not finish safely.'
    const retained = await boundary.retainedWorkspace()
    if (retained)
      failure.hint += ` Recover retained data at ${retained}; inspect it before manual cleanup.`
    writeFailure('download', failure, mode, 1)
  }
}

async function runDownloadInternal(
  parsed: ParsedArgs,
  mode: OutputMode,
  isRetry = false,
  boundary: WriteBoundary,
): Promise<void> {
  const command = 'download'
  const projectId = parsed.options.projectId?.trim()
  if (projectId !== undefined || parsed.positionals.length === 0) {
    if (
      !projectId ||
      parsed.positionals.length > 0 ||
      !parsed.options.output?.trim()
    ) {
      throw new DownloadFailure(
        validationError(
          'Invalid project download arguments.',
          'Use download <target> or download --project-id <id> --output <dir>.',
        ),
      )
    }
    return runProjectDownload(parsed, mode, projectId, isRetry, boundary)
  }
  const target = parseArtifactTarget(
    parsed.positionals[0],
    'download',
    'Pass an artifact ID or share URL to download.',
  )
  if (target.error) throw new DownloadFailure(target.error)
  const artifactId = target.artifactId
  const input = parsed.positionals[0]!
  if (!/^https?:\/\//i.test(input)) validateIds([{ id: input }])
  validateIds([{ id: artifactId }])

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
      () => runDownload(parsed, mode, true),
      isRetry,
    )
  }
  const request = await requestConfig(parsed.options)
  if (request.error) throw new DownloadFailure(request.error)

  const baseUrl = baseUrlOf(parsed.options)
  const manifestUrl = apiUrl(
    `/api/cli/artifacts/${encodeURIComponent(artifactId)}/download`,
    baseUrl,
  )
  const manifestResponse = await cliFetch(manifestUrl, {
    headers: { Authorization: `Bearer ${credential.token}` },
    ...request.init,
  })
  if ('networkError' in manifestResponse) {
    throw new DownloadFailure(networkError(manifestResponse.networkError))
  }

  const body = await readJson(manifestResponse)
  if (!manifestResponse.ok) {
    return handleAuthenticatedCredentialFailure(
      command,
      mapApiError(manifestResponse.status, body, {
        authenticated: true,
        artifactTarget: true,
        baseUrl,
        credentialSource: credential.source,
        profile: credential.profile,
        profileCredentialKind: credential.profileCredentialKind,
        botProfile: credential.botProfile,
      }),
      credential,
      parsed.options,
      mode,
      () => runDownload(parsed, mode, true),
      isRetry,
    )
  }
  if (!isRecord(body) || !('id' in body)) {
    throw new DownloadFailure(
      serviceError(
        'Download manifest succeeded but the response did not include file metadata.',
      ),
    )
  }
  validateIds([body])
  if (isRecord(body) && body.id !== artifactId)
    throw new DownloadManifestError(
      `Manifest artifact ID ${JSON.stringify(body.id)} does not match ${artifactId}.`,
    )
  if (!downloadManifestFields(body)) {
    throw new DownloadFailure(
      serviceError(
        'Download manifest succeeded but the response did not include file metadata.',
      ),
    )
  }

  boundary.watch(resolve(parsed.options.output ?? artifactId))
  const plan = await prepareDownloadPlan(
    body,
    parsed.options.output ?? artifactId,
    Boolean(parsed.options.force),
    boundary,
  )
  if (plan.error) throw new DownloadFailure(plan.error)

  for (const file of plan.value.files) {
    const fileUrl = downloadFileUrl(baseUrl, artifactId, file.path)
    const fileResponse = await cliFetch(fileUrl, {
      headers: { Authorization: `Bearer ${credential.token}` },
      ...request.init,
    })
    if ('networkError' in fileResponse) {
      throw new DownloadFailure(
        fileDownloadError(networkError(fileResponse.networkError), file.path),
      )
    }
    if (!fileResponse.ok) {
      const fileBody = await readJson(fileResponse)
      const apiError = isRecord(fileBody) ? fileBody.error : undefined
      const notFound =
        fileResponse.status === 404 ||
        apiError === 'not-found' ||
        (isRecord(apiError) && apiError.code === 'not-found')
      await boundary.cleanup()
      return handleAuthenticatedCredentialFailure(
        command,
        fileDownloadError(
          mapApiError(fileResponse.status, fileBody, {
            authenticated: true,
            ...(!notFound ? { artifactTarget: true } : {}),
            baseUrl,
            credentialSource: credential.source,
            profile: credential.profile,
            profileCredentialKind: credential.profileCredentialKind,
            botProfile: credential.botProfile,
          }),
          file.path,
          notFound,
        ),
        credential,
        parsed.options,
        mode,
        () => runDownload(parsed, mode, true),
        isRetry,
      )
    }
    let fileBody: ArrayBuffer
    try {
      fileBody = await fileResponse.arrayBuffer()
    } catch (error) {
      throw new DownloadFailure(
        fileDownloadError(networkError(error), file.path),
      )
    }
    const bytes = Buffer.from(fileBody)
    const verified = verifyDownloadedBytes(file, bytes)
    if (verified.error) {
      throw new DownloadFailure(verified.error)
    }
    await boundary.write(file.targetPath, bytes)
  }
  await boundary.replace(plan.value.tempRoot, plan.value.root)
  boundary.keep(plan.value.root)

  await boundary.finish()
  return writeSuccess(
    command,
    {
      backup_paths: boundary.backupPaths,
      artifact: {
        id: body.id,
        url: body.share_url,
        kind: body.artifact_kind,
      },
      version: {
        id: body.version_id,
      },
      destination: {
        path: plan.value.root,
      },
      files: {
        count: plan.value.files.length,
        total_size_bytes: body.total_size_bytes,
      },
    },
    mode,
  )
}

async function runProjectDownload(
  parsed: ParsedArgs,
  mode: OutputMode,
  projectId: string,
  isRetry = false,
  boundary: WriteBoundary,
): Promise<void> {
  const command = 'download'
  const resolved = await resolveCredential(
    parsed.options,
    await resolveProjectConfig(),
  )
  if (!resolved.ok) {
    return handleCredentialFailure(
      command,
      resolved,
      parsed.options,
      mode,
      () => runDownload(parsed, mode, true),
      isRetry,
    )
  }
  const request = await requestConfig(parsed.options)
  if (request.error) throw new DownloadFailure(request.error)
  const baseUrl = baseUrlOf(parsed.options)
  // A project download can outlive an expired session, so refresh once mid-run
  // and funnel every authenticated request through this fetch.
  let credential = resolved
  let refreshAttempted = false
  const authFetch = async (url: URL) => {
    const response = await cliFetch(url, {
      headers: { Authorization: `Bearer ${credential.token}` },
      ...request.init,
    })
    if ('networkError' in response || response.status !== 401) return response
    if (refreshAttempted) return response
    refreshAttempted = true
    const body = await readJson(response.clone())
    const refreshed = await refreshAuthenticatedCredential(
      mapApiError(response.status, body, {
        authenticated: true,
        baseUrl,
        artifactTarget: true,
        credentialSource: credential.source,
        profile: credential.profile,
        profileCredentialKind: credential.profileCredentialKind,
        botProfile: credential.botProfile,
      }),
      credential,
      parsed.options,
      isRetry,
    )
    if (!refreshed.ok) return response
    credential = { ...credential, ...refreshed.credential, ok: true }
    return await cliFetch(url, {
      headers: { Authorization: `Bearer ${credential.token}` },
      ...request.init,
    })
  }
  const output = resolve(parsed.options.output!.trim())
  const list = async (cursor?: string) => {
    const url = apiUrl('/api/cli/artifacts', baseUrl)
    url.searchParams.set('project_id', projectId)
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await authFetch(url)
    if ('networkError' in response)
      return { error: networkError(response.networkError) }
    const body = await readJson(response)
    if (!response.ok)
      return {
        error: mapApiError(response.status, body, {
          authenticated: true,
          baseUrl,
          artifactTarget: true,
          credentialSource: credential.source,
          profile: credential.profile,
          profileCredentialKind: credential.profileCredentialKind,
          botProfile: credential.botProfile,
        }),
        authFailure: response.status === 401,
      }
    const contracted = ARTIFACTS_LIST_RESPONSE_SCHEMA.safeParse(body)
    const raw = isRecord(body) ? body : null
    if (
      !contracted.success &&
      (!raw ||
        !Array.isArray(raw.artifacts) ||
        typeof raw.has_more !== 'boolean')
    )
      return { error: serviceError('Artifact list response was invalid.') }
    const data = contracted.success
      ? contracted.data
      : {
          artifacts: raw!.artifacts as Array<Record<string, unknown>>,
          has_more: raw!.has_more as boolean,
          next_cursor:
            typeof raw!.next_cursor === 'string' || raw!.next_cursor === null
              ? raw!.next_cursor
              : undefined,
        }
    return {
      data: data as {
        artifacts: Array<Record<string, unknown>>
        has_more: boolean
        next_cursor?: string | null
      },
    }
  }
  const entries: Array<Record<string, unknown>> = []
  let cursor: string | undefined
  let first = true
  let listError:
    | ReturnType<typeof networkError>
    | ReturnType<typeof serviceError>
    | undefined
  do {
    const page = await list(cursor)
    if (page.error) {
      if (first && page.authFailure) {
        // authFetch already spent the single session-refresh attempt, so fall
        // straight to the login flow instead of refreshing a second time.
        return handleCredentialFailure(
          command,
          {
            ok: false,
            source: credential.source,
            ...(credential.profile ? { profile: credential.profile } : {}),
            error: page.error,
          },
          parsed.options,
          mode,
          () => runDownload(parsed, mode, true),
          isRetry,
        )
      }
      listError = page.error
      break
    }
    entries.push(...page.data.artifacts)
    first = false
    cursor =
      page.data.has_more && page.data.next_cursor
        ? page.data.next_cursor
        : undefined
  } while (cursor)
  if (listError && first) throw new DownloadFailure(listError)
  validateIds(entries)
  boundary.watch(output)
  await boundary.outputParent(dirname(output))
  await boundary.record(output, true)
  const previousVersions = await readPreviousVersions(output, boundary)
  for (const item of entries) {
    const root = join(output, item.id as string)
    await boundary.record(root, true)
    await boundary.tree(root)
  }
  await boundary.directory(output)
  boundary.workspace = await boundary.privateDirectory(dirname(output))
  boundary.keep(output)
  const results: ProjectResult[] = entries.map((item) => ({
    id: item.id as string,
    title: String(item.title ?? ''),
    ...(typeof item.owner_email === 'string'
      ? { owner_email: item.owner_email }
      : {}),
    updated_at: String(item.updated_at ?? ''),
    share_url: String(item.share_url ?? ''),
    status: 'failed',
    reason: listError ? 'list interrupted' : 'download failed',
  }))
  if (!listError) {
    for (let i = 0; i < entries.length; i++) {
      const item = entries[i]!
      const result = results[i]!
      if (
        item.artifact_kind === 'spa' ||
        item.artifact_kind === 'workspace_app'
      ) {
        result.status = 'skipped'
        result.reason = 'unsupported-kind'
        continue
      }
      const root = join(output, result.id)
      try {
        const rootExists = await boundary.record(root, true)
        const response = await authFetch(
          apiUrl(
            `/api/cli/artifacts/${encodeURIComponent(result.id)}/download`,
            baseUrl,
          ),
        )
        if ('networkError' in response) {
          result.reason = 'network failed'
          continue
        }
        if (!response.ok) {
          const body = await readJson(response)
          const apiError = mapApiError(response.status, body, {
            authenticated: true,
            baseUrl,
            artifactTarget: true,
          })
          if (apiError.code === 'unsupported_kind') {
            result.status = 'skipped'
            result.reason = 'unsupported-kind'
          } else {
            result.reason = `download failed (${response.status})`
          }
          continue
        }
        const body = await readJson(response)
        if (!isRecord(body) || body.id !== result.id) {
          throw new DownloadManifestError(
            `Download manifest artifact ID does not match ${result.id}.`,
          )
        }
        if (!downloadManifestFields(body)) {
          throw new DownloadManifestError(
            `Invalid download manifest for artifact ${result.id}.`,
          )
        }
        // Re-runs are an incremental sync: an unchanged version with its output
        // still on disk needs no file requests. --force wins and re-downloads.
        if (
          !parsed.options.force &&
          rootExists &&
          previousVersions.get(result.id) === body.version_id
        ) {
          result.status = 'unchanged'
          result.version_id = body.version_id
          result.path = root
          delete result.reason
          continue
        }
        if (rootExists && !parsed.options.force) {
          result.reason = 'artifact output already exists'
          continue
        }
        const plan = await prepareDownloadPlan(
          body,
          root,
          Boolean(parsed.options.force),
          boundary,
          true,
        )
        if (plan.error) {
          result.reason = plan.error.message
          continue
        }
        for (const file of plan.value.files) {
          const fileResponse = await authFetch(
            downloadFileUrl(baseUrl, result.id, file.path),
          )
          if ('networkError' in fileResponse)
            throw new DownloadFileError(
              `Could not download file "${file.path}": network failed`,
            )
          if (!fileResponse.ok)
            throw new DownloadFileError(
              `Could not download file "${file.path}" (${fileResponse.status})`,
            )
          let fileBody: ArrayBuffer
          try {
            fileBody = await fileResponse.arrayBuffer()
          } catch {
            throw new DownloadFileError(
              `Could not download file "${file.path}": network failed while reading response body`,
            )
          }
          const bytes = Buffer.from(fileBody)
          const verified = verifyDownloadedBytes(file, bytes)
          if (verified.error)
            throw new DownloadFileError(verified.error.message)
          await boundary.write(file.targetPath, bytes)
        }
        await boundary.replace(plan.value.tempRoot, plan.value.root)
        boundary.keep(plan.value.root)
        result.status = 'ok'
        result.version_id = body.version_id
        result.path = root
        delete result.reason
      } catch (error) {
        await boundary.check(output, dirname(output), boundary.workspace!)
        if (error instanceof WriteBoundaryError) throw error
        result.reason =
          error instanceof DownloadManifestError
            ? `${error.message} ${error.error.hint}`
            : error instanceof DownloadFileError
              ? error.message
              : 'download failed; check filesystem availability and retry'
      }
    }
  }
  await boundary.atomicWrite(
    join(output, 'index.json'),
    JSON.stringify({ project_id: projectId, artifacts: results }, null, 2) +
      '\n',
    true,
  )
  boundary.keep(join(output, 'index.json'))
  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  }
  await boundary.finish()
  process.exitCode = counts.failed > 0 ? 1 : 0
  return writeSuccess(
    command,
    {
      project_id: projectId,
      backup_paths: boundary.backupPaths,
      ...counts,
      failures: results
        .filter((r) => r.status === 'failed')
        .map((r) => ({ id: r.id, reason: r.reason })),
      artifacts: results,
    },
    mode,
  )
}
