import { mkdir, readFile, rename, rm, writeFile, lstat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OutputMode, ParsedArgs } from '../types.js'
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
  backupPathFor,
  downloadFileSystemError,
  pathExists,
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
async function readPreviousVersions(
  output: string,
): Promise<Map<string, string>> {
  try {
    const parsed = JSON.parse(
      await readFile(join(output, 'index.json'), 'utf8'),
    ) as { artifacts?: unknown }
    if (!Array.isArray(parsed.artifacts)) return new Map()
    // Validate the whole structure first: a corrupt index must yield no
    // previous information, not the valid prefix of a broken artifacts array.
    const previous = new Map<string, string>()
    for (const entry of parsed.artifacts) {
      if (entry === null || typeof entry !== 'object') return new Map()
      const { id, version_id } = entry as { id?: unknown; version_id?: unknown }
      if (typeof id !== 'string') return new Map()
      if (typeof version_id === 'string') previous.set(id, version_id)
    }
    return previous
  } catch {
    return new Map()
  }
}

export async function runDownload(
  parsed: ParsedArgs,
  mode: OutputMode,
  isRetry = false,
): Promise<void> {
  const command = 'download'
  const projectId = parsed.options.projectId?.trim()
  if (projectId !== undefined || parsed.positionals.length === 0) {
    if (
      !projectId ||
      parsed.positionals.length > 0 ||
      !parsed.options.output?.trim()
    ) {
      return writeFailure(
        command,
        validationError(
          'Invalid project download arguments.',
          'Use download <target> or download --project-id <id> --output <dir>.',
        ),
        mode,
        1,
      )
    }
    return runProjectDownload(parsed, mode, projectId, isRetry)
  }
  const target = parseArtifactTarget(
    parsed.positionals[0],
    'download',
    'Pass an artifact ID or share URL to download.',
  )
  if (target.error) return writeFailure(command, target.error, mode, 1)
  const artifactId = target.artifactId

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
  if (request.error) return writeFailure(command, request.error, mode, 1)

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
    return writeFailure(
      command,
      networkError(manifestResponse.networkError),
      mode,
      1,
    )
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
  if (!downloadManifestFields(body)) {
    return writeFailure(
      command,
      serviceError(
        'Download manifest succeeded but the response did not include file metadata.',
      ),
      mode,
      1,
    )
  }

  const plan = await prepareDownloadPlan(
    body,
    parsed.options.output ?? artifactId,
    Boolean(parsed.options.force),
  )
  if (plan.error) return writeFailure(command, plan.error, mode, 1)

  let completed = false
  let backupRoot: string | null = null
  try {
    for (const file of plan.value.files) {
      const fileUrl = downloadFileUrl(baseUrl, artifactId, file.path)
      const fileResponse = await cliFetch(fileUrl, {
        headers: { Authorization: `Bearer ${credential.token}` },
        ...request.init,
      })
      if ('networkError' in fileResponse) {
        return writeFailure(
          command,
          networkError(fileResponse.networkError),
          mode,
          1,
        )
      }
      if (!fileResponse.ok) {
        return handleAuthenticatedCredentialFailure(
          command,
          mapApiError(fileResponse.status, await readJson(fileResponse), {
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
      const bytes = Buffer.from(await fileResponse.arrayBuffer())
      const verified = verifyDownloadedBytes(file, bytes)
      if (verified.error) {
        return writeFailure(command, verified.error, mode, 1)
      }
      await mkdir(dirname(file.targetPath), { recursive: true })
      await writeFile(file.targetPath, bytes)
    }
    if (plan.value.replaceExisting) {
      backupRoot = backupPathFor(plan.value.root)
      await rename(plan.value.root, backupRoot)
    }
    await rename(plan.value.tempRoot, plan.value.root)
    completed = true
    if (backupRoot) {
      await rm(backupRoot, { recursive: true, force: true }).catch(() => {})
    }
  } catch (error) {
    if (
      backupRoot &&
      !(await pathExists(plan.value.root)) &&
      (await pathExists(backupRoot))
    ) {
      await rename(backupRoot, plan.value.root).catch(() => {})
    }
    return writeFailure(command, downloadFileSystemError(error), mode, 1)
  } finally {
    if (!completed) {
      await rm(plan.value.tempRoot, { recursive: true, force: true }).catch(
        () => {},
      )
    }
  }

  return writeSuccess(
    command,
    {
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
  if (request.error) return writeFailure(command, request.error, mode, 1)
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
  const output = parsed.options.output!.trim()
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
    if (
      !body ||
      !Array.isArray(body.artifacts) ||
      typeof body.has_more !== 'boolean'
    )
      return { error: serviceError('Artifact list response was invalid.') }
    return {
      data: body as {
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
  if (listError && first) return writeFailure(command, listError, mode, 1)
  // Same output-path symlink guard as prepareDownloadPlan applies per artifact
  // in single mode: never write through a symlinked project root.
  if ((await lstat(output).catch(() => null))?.isSymbolicLink()) {
    return writeFailure(
      command,
      validationError(
        'Output path must not be a symbolic link.',
        'Choose a regular directory path and retry.',
      ),
      mode,
      1,
    )
  }
  const previousVersions = await readPreviousVersions(output)
  await mkdir(output, { recursive: true })
  const results: ProjectResult[] = entries.map((item) => ({
    id: String(item.id),
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
      const rootStat = await lstat(root).catch(() => null)
      const rootExists = rootStat !== null
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
      if (!downloadManifestFields(body)) {
        result.reason = 'invalid download manifest'
        continue
      }
      // Re-runs are an incremental sync: an unchanged version with its output
      // still on disk needs no file requests. --force wins and re-downloads.
      if (
        !parsed.options.force &&
        rootStat?.isDirectory() &&
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
      )
      if (plan.error) {
        result.reason = plan.error.message
        continue
      }
      try {
        for (const file of plan.value.files) {
          const fileResponse = await authFetch(
            downloadFileUrl(baseUrl, result.id, file.path),
          )
          if ('networkError' in fileResponse) throw new Error('network failed')
          if (!fileResponse.ok)
            throw new Error(`file download failed (${fileResponse.status})`)
          const bytes = Buffer.from(await fileResponse.arrayBuffer())
          const verified = verifyDownloadedBytes(file, bytes)
          if (verified.error) throw new Error(verified.error.message)
          await mkdir(dirname(file.targetPath), { recursive: true })
          await writeFile(file.targetPath, bytes)
        }
        // Same backup-and-restore replacement as the single-artifact path: a
        // failed rename must never lose the previously downloaded directory.
        let backupRoot: string | null = null
        try {
          if (plan.value.replaceExisting) {
            backupRoot = backupPathFor(plan.value.root)
            await rename(plan.value.root, backupRoot)
          }
          await rename(plan.value.tempRoot, plan.value.root)
        } catch (error) {
          if (
            backupRoot &&
            !(await pathExists(plan.value.root)) &&
            (await pathExists(backupRoot))
          ) {
            await rename(backupRoot, plan.value.root).catch(() => {})
          }
          throw error
        }
        if (backupRoot) {
          await rm(backupRoot, { recursive: true, force: true }).catch(() => {})
        }
        result.status = 'ok'
        result.version_id = body.version_id
        result.path = root
        delete result.reason
      } catch (error) {
        result.reason =
          error instanceof Error ? error.message : 'download failed'
        await rm(plan.value.tempRoot, { recursive: true, force: true }).catch(
          () => {},
        )
      }
    }
  }
  try {
    await writeFile(
      join(output, 'index.json'),
      JSON.stringify({ project_id: projectId, artifacts: results }, null, 2) +
        '\n',
    )
  } catch (error) {
    return writeFailure(command, downloadFileSystemError(error), mode, 1)
  }
  const counts = {
    ok: results.filter((r) => r.status === 'ok').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    failed: results.filter((r) => r.status === 'failed').length,
  }
  process.exitCode = counts.failed > 0 ? 1 : 0
  return writeSuccess(
    command,
    {
      project_id: projectId,
      ...counts,
      failures: results
        .filter((r) => r.status === 'failed')
        .map((r) => ({ id: r.id, reason: r.reason })),
      artifacts: results,
    },
    mode,
  )
}
