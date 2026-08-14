import { SCHEMA_VERSION } from './constants.js'
import type {
  OpenData,
  ArtifactGetData,
  ArtifactsListData,
  DeleteData,
  CliError,
  CliOptions,
  DownloadManifest,
  DownloadManifestFile,
  OutputMode,
  ResolveData,
  SkillAutoUpdateData,
} from './types.js'
import { serviceError } from './errors.js'
import { isRecord } from './validators.js'

export function outputModeFromArgv(argv: string[]): OutputMode {
  return outputMode({ json: argv.includes('--json') })
}

export function outputMode(options: CliOptions): OutputMode {
  return {
    json:
      Boolean(options.json) ||
      process.env.CI === 'true' ||
      !process.stdout.isTTY,
  }
}

export function writeSuccess(
  command: string,
  data: unknown,
  mode: OutputMode,
): void {
  if (!mode.json && command === 'share' && !shareSuccessFields(data)) {
    return writeFailure(
      command,
      serviceError(
        'Share succeeded but the response did not include an artifact id and URL.',
      ),
      mode,
      1,
    )
  }
  const payload = { schema_version: SCHEMA_VERSION, ok: true, command, data }
  if (mode.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  process.stdout.write(humanSuccess(command, data))
}

export function dataWithSkillAutoUpdate<T>(
  data: T,
  autoUpdate: SkillAutoUpdateData | undefined,
): T {
  if (!autoUpdate || autoUpdate.targets.length === 0) return data
  if (!isRecord(data)) return data
  const existingSkills = isRecord(data.skills) ? data.skills : {}
  return {
    ...data,
    skills: {
      ...existingSkills,
      auto_update: autoUpdate,
    },
  }
}

export function writeFailure(
  command: string,
  error: CliError,
  mode: OutputMode,
  exitCode: number,
): void {
  const payload = { schema_version: SCHEMA_VERSION, ok: false, command, error }
  if (mode.json) {
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`)
  } else {
    const upgradeRequest = isRecord(error.details?.upgrade_request)
      ? error.details.upgrade_request
      : null
    const upgradeHint =
      upgradeRequest?.kind === 'contact' &&
      typeof upgradeRequest.request_message === 'string'
        ? upgradeRequest.request_message
        : upgradeRequest?.kind === 'billing' &&
            typeof upgradeRequest.upgrade_url === 'string'
          ? upgradeRequest.upgrade_url
          : upgradeRequest?.kind === 'support' &&
              typeof upgradeRequest.support_url === 'string'
            ? upgradeRequest.support_url
            : null
    process.stderr.write(
      `Error: ${error.message}\nWhy: ${error.why}\nHint: ${error.hint}${upgradeHint ? `\n${upgradeHint}` : ''}\n`,
    )
  }
  process.exitCode = exitCode
}

export function writeText(text: string): void {
  process.stdout.write(text)
}

// Progress events go to stderr as one JSON line so stdout stays reserved for
// the single final success JSON. Failure JSON is distinguishable by its
// schema_version/ok envelope.
export function writeEvent(data: unknown): void {
  process.stderr.write(`${JSON.stringify(data)}\n`)
}

function humanSuccess(command: string, data: unknown): string {
  const suffix = skillAutoUpdateHumanOutput(data)
  if (command === 'share') {
    const fields = shareSuccessFields(data)
    if (!fields) return `${JSON.stringify(data, null, 2)}\n`
    const output = [
      'Shared',
      `Artifact ID: ${fields.artifactId}`,
      `URL: ${fields.url}`,
      `Destination: ${fields.destinationType}${fields.projectId ? ` (${fields.projectId})` : ''}`,
      `Visibility: ${fields.visibility}`,
      '',
    ].join('\n')
    return suffix ? `${output}${suffix}` : output
  }
  if (command === 'doctor') {
    return doctorHumanOutput(data)
  }
  if (command === 'open') {
    return openHumanOutput(data)
  }
  if (command === 'init') {
    return initHumanOutput(data)
  }
  if (
    command === 'artifacts list' &&
    isRecord(data) &&
    data.has_more === true &&
    typeof data.next_cursor === 'string'
  ) {
    return `${JSON.stringify(data, null, 2)}\nContinue with --cursor ${data.next_cursor}\n`
  }
  if (command === 'changelog') {
    return changelogHumanOutput(data)
  }
  const output = `${JSON.stringify(data, null, 2)}\n`
  return suffix ? `${output}${suffix}` : output
}

export function skillAutoUpdateHumanOutput(data: unknown): string {
  if (!isRecord(data)) return ''
  const skills = data.skills
  if (!isRecord(skills)) return ''
  const autoUpdate = skills.auto_update
  if (!isRecord(autoUpdate) || !Array.isArray(autoUpdate.targets)) return ''
  const lines = autoUpdate.targets.filter(isRecord).map((target) => {
    const label =
      typeof target.tool === 'string' && typeof target.scope === 'string'
        ? `${target.tool}:${target.scope}`
        : 'unknown'
    if (
      target.action === 'update_recommended' &&
      typeof target.update_command === 'string'
    ) {
      return `Skill update recommended: ${label} (${target.update_command})`
    }
    return `Skill updated: ${label}`
  })
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function initHumanOutput(data: unknown): string {
  const body = `${JSON.stringify(data, null, 2)}`
  const nextCommand = initNextCommand(data)
  if (!nextCommand) return `${body}\n`
  return `${body}\nNext command: ${nextCommand}\n`
}

// Surface the first not-yet-done onboarding step (sign in, then share) as the
// actionable next command, the same way open and doctor do.
function initNextCommand(data: unknown): string | null {
  if (!isRecord(data) || data.mode !== 'onboarding') return null
  const steps = data.next_steps
  if (!Array.isArray(steps)) return null
  const pending = steps.find(
    (step) =>
      isRecord(step) && step.done !== true && typeof step.command === 'string',
  )
  return isRecord(pending) && typeof pending.command === 'string'
    ? pending.command
    : null
}

function openHumanOutput(data: unknown): string {
  const body = `${JSON.stringify(data, null, 2)}`
  const nextCommand = openNextCommand(data)
  if (!nextCommand) return `${body}\n`
  return `${body}\nNext command: ${nextCommand}\n`
}

function openNextCommand(data: unknown): string | null {
  if (!isOpenData(data)) return null
  return data.open.kind === 'download_required' ? data.open.next_command : null
}

function isOpenData(data: unknown): data is OpenData {
  if (!isRecord(data)) return false
  const open = data.open
  if (!isRecord(open)) return false
  if (open.kind === 'read') return true
  return (
    open.kind === 'download_required' && typeof open.next_command === 'string'
  )
}

function doctorHumanOutput(data: unknown): string {
  const nextCommand = doctorNextCommand(data)
  const body = `${JSON.stringify(data, null, 2)}`
  if (!nextCommand) return `${body}\n`
  return `${body}\n${nextCommand}\n`
}

function doctorNextCommand(data: unknown): string | null {
  if (!isRecord(data) || !('next_command' in data)) return null
  return typeof data.next_command === 'string' ? data.next_command : null
}

function changelogHumanOutput(data: unknown): string {
  if (!isRecord(data)) return `${JSON.stringify(data, null, 2)}\n`
  const version = typeof data.version === 'string' ? data.version : ''
  const updatesUrl =
    typeof data.updates_url === 'string' ? data.updates_url : ''
  const lines = [`Artifact Share CLI ${version}`, '', `Updates: ${updatesUrl}`]
  const latest = data.latest
  if (isRecord(latest) && typeof latest.body === 'string' && latest.body) {
    const latestVersion =
      typeof latest.version === 'string' ? latest.version : version
    const latestDate = typeof latest.date === 'string' ? latest.date : ''
    lines.push('', `Changes in ${latestVersion} (${latestDate}):`, latest.body)
  }
  return `${lines.join('\n')}\n`
}

function shareSuccessFields(data: unknown): {
  artifactId: string
  url: string
  destinationType: string
  projectId: string | null
  visibility: string
} | null {
  if (!isRecord(data)) return null
  const artifact = data.artifact
  const destination = data.destination
  const share = data.share
  if (!isRecord(artifact) || !isRecord(destination) || !isRecord(share)) {
    return null
  }
  if (
    typeof artifact.id !== 'string' ||
    typeof artifact.url !== 'string' ||
    typeof destination.type !== 'string' ||
    typeof share.visibility !== 'string'
  ) {
    return null
  }
  return {
    artifactId: artifact.id,
    url: artifact.url,
    destinationType: destination.type,
    projectId:
      typeof destination.project_id === 'string'
        ? destination.project_id
        : null,
    visibility: share.visibility,
  }
}

export function updateSuccessFields(data: unknown): {
  artifactId: string
  url: string
  versionId: string
} | null {
  if (!isRecord(data)) return null
  const artifact = data.artifact
  const version = data.version
  if (!isRecord(artifact) || !isRecord(version)) return null
  if (
    typeof artifact.id !== 'string' ||
    typeof artifact.url !== 'string' ||
    typeof version.id !== 'string'
  ) {
    return null
  }
  return {
    artifactId: artifact.id,
    url: artifact.url,
    versionId: version.id,
  }
}

export function resolveSuccessFields(data: unknown): data is ResolveData {
  if (!isRecord(data)) return false
  return (
    typeof data.query === 'string' &&
    Array.isArray(data.candidates) &&
    typeof data.has_more === 'boolean'
  )
}

export function artifactGetSuccessFields(
  data: unknown,
): data is ArtifactGetData {
  if (!isRecord(data)) return false
  return (
    typeof data.id === 'string' &&
    typeof data.share_url === 'string' &&
    typeof data.version_id === 'string' &&
    (data.format === 'html' || data.format === 'markdown') &&
    typeof data.content === 'string' &&
    typeof data.size_bytes === 'number' &&
    typeof data.truncated === 'boolean' &&
    (typeof data.next_offset === 'number' || data.next_offset === null) &&
    (data.link_expires_at === undefined ||
      typeof data.link_expires_at === 'string' ||
      data.link_expires_at === null)
  )
}

export function artifactsListSuccessFields(
  data: unknown,
): data is ArtifactsListData {
  if (!isRecord(data)) return false
  return (
    Array.isArray(data.artifacts) &&
    data.artifacts.every((item) => {
      if (!isRecord(item)) return false
      return (
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.share_url === 'string' &&
        typeof item.visibility === 'string' &&
        (item.link_expires_at === undefined ||
          typeof item.link_expires_at === 'string' ||
          item.link_expires_at === null) &&
        typeof item.updated_at === 'string' &&
        (typeof item.project_id === 'string' || item.project_id === null) &&
        (item.owner_email === undefined ||
          typeof item.owner_email === 'string') &&
        (item.artifact_kind === undefined ||
          typeof item.artifact_kind === 'string')
      )
    }) &&
    typeof data.limit === 'number' &&
    typeof data.has_more === 'boolean' &&
    (typeof data.next_cursor === 'string' || data.next_cursor === null)
  )
}

export function deleteSuccessFields(data: unknown): data is DeleteData {
  if (!isRecord(data)) return false
  return typeof data.id === 'string' && data.deleted === true
}

export function downloadManifestFields(
  data: unknown,
): data is DownloadManifest {
  if (!isRecord(data)) return false
  return (
    typeof data.id === 'string' &&
    typeof data.share_url === 'string' &&
    typeof data.version_id === 'string' &&
    typeof data.artifact_kind === 'string' &&
    Array.isArray(data.files) &&
    data.files.every(downloadManifestFileFields) &&
    typeof data.total_size_bytes === 'number' &&
    (data.project_id === undefined ||
      typeof data.project_id === 'string' ||
      data.project_id === null)
  )
}

function downloadManifestFileFields(
  data: unknown,
): data is DownloadManifestFile {
  if (!isRecord(data)) return false
  return (
    typeof data.path === 'string' &&
    typeof data.size_bytes === 'number' &&
    typeof data.content_type === 'string' &&
    typeof data.sha256 === 'string'
  )
}
