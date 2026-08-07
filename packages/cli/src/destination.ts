import { readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type {
  CliError,
  CliOptions,
  Destination,
  ProjectConfig,
} from './types.js'
import { validationError } from './errors.js'
import { isRecord, nonEmpty } from './validators.js'
import { configHome, readGlobalConfig } from './token-store.js'

export function destinationConflictError(options: CliOptions): CliError | null {
  const projectName = nonEmpty(options.project)
  if (options.home && (options.projectId || projectName)) {
    return validationError(
      'Choose either --home or a project destination.',
      'Remove one destination option and retry.',
      'destination_conflict',
    )
  }
  if (projectName && options.projectId) {
    return validationError(
      'Choose either --project or --project-id.',
      'Remove one destination option and retry.',
      'destination_conflict',
    )
  }
  return null
}

export function resolveDestination(
  options: CliOptions,
  config: ProjectConfig | null,
): Destination {
  const conflict = destinationConflictError(options)
  if (conflict) return { error: conflict }
  // An explicit --home must beat the working-directory default project, or
  // the artifact silently lands in the configured project instead of home.
  if (options.home) return { containerId: null }
  const containerId = options.projectId ?? config?.default_project_id ?? null
  if (containerId) return { containerId }
  return { containerId: null }
}

export const PROJECT_CONFIG_PATH = '.artifactshare/config.json'
export const PROJECT_CONFIG_LOCAL_PATH = '.artifactshare/config.local.json'

export type ProjectConfigKind = 'local' | 'shared'

export type ProjectConfigResolution = {
  config: ProjectConfig | null
  raw: Record<string, unknown> | null
  kind: ProjectConfigKind | null
  path: string | null
  directory: string | null
  error?: CliError
}

export function projectConfigPath(cwd = process.cwd()): string {
  return resolve(cwd, PROJECT_CONFIG_PATH)
}

export function projectConfigLocalPath(cwd = process.cwd()): string {
  return resolve(cwd, PROJECT_CONFIG_LOCAL_PATH)
}

export function relativeProjectConfigPath(
  cwd: string,
  directory: string,
  filename: string,
): string {
  const absolute = join(directory, filename)
  const rel = relative(cwd, absolute)
  return rel.startsWith('..') ? absolute : rel
}

export async function resolveProjectConfig(
  cwd = process.cwd(),
): Promise<ProjectConfigResolution> {
  let current = resolve(cwd)
  const root = resolve(current, '/')

  while (true) {
    const localPath = join(current, PROJECT_CONFIG_LOCAL_PATH)
    const sharedPath = join(current, PROJECT_CONFIG_PATH)
    const localRaw = await readJsonFile<Record<string, unknown>>(localPath)
    if (localRaw !== null) {
      return {
        config: localRaw as ProjectConfig,
        raw: localRaw,
        kind: 'local',
        path: relativeProjectConfigPath(
          cwd,
          current,
          PROJECT_CONFIG_LOCAL_PATH,
        ),
        directory: current,
      }
    }
    const sharedRaw = await readJsonFile<Record<string, unknown>>(sharedPath)
    if (sharedRaw !== null) {
      return {
        config: sharedRaw as ProjectConfig,
        raw: sharedRaw,
        kind: 'shared',
        path: relativeProjectConfigPath(cwd, current, PROJECT_CONFIG_PATH),
        directory: current,
      }
    }
    if (current === root) break
    current = dirname(current)
  }

  return {
    config: null,
    raw: null,
    kind: null,
    path: null,
    directory: null,
  }
}

export async function resolveSharedProjectConfig(
  cwd = process.cwd(),
): Promise<ProjectConfigResolution> {
  let current = resolve(cwd)
  const root = resolve(current, '/')
  while (true) {
    const path = join(current, PROJECT_CONFIG_PATH)
    try {
      const text = await readFile(path, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return invalidProjectConfigResolution(
          path,
          'Repository config contains invalid JSON.',
        )
      }
      if (!isRecord(parsed)) {
        return invalidProjectConfigResolution(
          path,
          'Repository config must contain a JSON object.',
        )
      }
      return {
        config: parsed as ProjectConfig,
        raw: parsed,
        kind: 'shared',
        path: relativeProjectConfigPath(cwd, current, PROJECT_CONFIG_PATH),
        directory: current,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return invalidProjectConfigResolution(
          path,
          'Repository config could not be read.',
        )
      }
    }
    if (current === root) break
    current = dirname(current)
  }
  return { config: null, raw: null, kind: null, path: null, directory: null }
}

function invalidProjectConfigResolution(
  path: string,
  message: string,
): ProjectConfigResolution {
  return {
    config: null,
    raw: null,
    kind: null,
    path,
    directory: dirname(path),
    error: validationError(
      message,
      `Fix or restore access to ${path} before resolving visibility settings.`,
    ),
  }
}

export type VisibilityResolution = {
  value: import('./types.js').ArtifactVisibility
  source: 'explicit' | 'repository' | 'user' | 'product_default'
}

export type VisibilityResolutionError = {
  invalid: 'explicit' | 'repository' | 'user'
}

export function resolveVisibility(
  explicitValue: unknown,
  repositoryValue: unknown,
  userValue: unknown,
): VisibilityResolution | VisibilityResolutionError {
  const candidates = [
    { value: explicitValue, source: 'explicit' as const },
    { value: repositoryValue, source: 'repository' as const },
    { value: userValue, source: 'user' as const },
  ]
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue
    if (candidate.value === 'workspace' || candidate.value === 'private') {
      return {
        value: candidate.value,
        source: candidate.source,
      }
    }
    return { invalid: candidate.source }
  }
  return { value: 'workspace', source: 'product_default' }
}

export function resolveHomeVisibility(
  explicitValue: unknown,
  repositoryHomeValue: unknown,
  repositoryLegacyValue: unknown,
  userHomeValue: unknown,
  userLegacyValue: unknown,
): VisibilityResolution | VisibilityResolutionError {
  const candidates = [
    { value: explicitValue, source: 'explicit' as const },
    { value: repositoryHomeValue, source: 'repository' as const },
    { value: repositoryLegacyValue, source: 'repository' as const },
    { value: userHomeValue, source: 'user' as const },
    { value: userLegacyValue, source: 'user' as const },
  ]
  for (const candidate of candidates) {
    if (candidate.value === undefined) continue
    if (candidate.value === 'workspace' || candidate.value === 'private') {
      return { value: candidate.value, source: candidate.source }
    }
    return { invalid: candidate.source }
  }
  return { value: 'workspace', source: 'product_default' }
}

export async function resolveDefaultVisibility(
  key: import('./types.js').ConfigKey,
  repositoryConfig?: ProjectConfigResolution,
): Promise<VisibilityResolution | { error: CliError }> {
  const shared = repositoryConfig ?? (await resolveSharedProjectConfig())
  if (shared.error) return { error: shared.error }
  const homeKey =
    key === 'home_audience' || key === 'default_artifact_visibility'
  const repositoryValue = homeKey
    ? shared.config?.home_audience
    : shared.config?.[key]
  const repositoryLegacyValue = homeKey
    ? shared.config?.default_artifact_visibility
    : undefined
  if (homeKey && repositoryValue === undefined) {
    if (repositoryLegacyValue !== undefined) {
      const resolution = resolveHomeVisibility(
        undefined,
        undefined,
        repositoryLegacyValue,
        undefined,
        undefined,
      )
      if (!('invalid' in resolution)) return resolution
      return {
        error: validationError(
          'Repository home_audience must be workspace or private.',
          'Fix the repository config before resolving visibility settings.',
        ),
      }
    }
  } else if (repositoryValue !== undefined) {
    const resolution = homeKey
      ? resolveHomeVisibility(
          undefined,
          repositoryValue,
          repositoryLegacyValue,
          undefined,
          undefined,
        )
      : resolveVisibility(undefined, repositoryValue, undefined)
    if (!('invalid' in resolution)) return resolution
    return {
      error: validationError(
        `Repository ${key} must be workspace or private.`,
        'Fix the repository config before resolving visibility settings.',
      ),
    }
  }
  const home = configHome()
  let global: Record<string, unknown> | null = null
  if (home) {
    const path = join(home, 'config.json')
    try {
      const text = await readFile(path, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return {
          error: validationError(
            'User config contains invalid JSON.',
            `Fix ${path} before resolving visibility settings.`,
          ),
        }
      }
      if (!isRecord(parsed)) {
        return {
          error: validationError(
            'User config must contain a JSON object.',
            `Fix ${path} before resolving visibility settings.`,
          ),
        }
      }
      global = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          error: validationError(
            'User config could not be read.',
            `Check access to ${path} before resolving visibility settings.`,
          ),
        }
      }
    }
  } else {
    global = await readGlobalConfig()
  }
  const resolution = homeKey
    ? resolveHomeVisibility(
        undefined,
        undefined,
        undefined,
        global?.home_audience,
        global?.default_artifact_visibility,
      )
    : resolveVisibility(undefined, undefined, global?.[key])
  if (!('invalid' in resolution)) return resolution
  return {
    error: validationError(
      `User ${homeKey ? 'home_audience' : key} must be workspace or private.`,
      'Fix the user config before resolving visibility settings.',
    ),
  }
}

export async function readProjectConfigAtDirectory(
  directory: string,
  kind: ProjectConfigKind,
): Promise<Record<string, unknown> | null> {
  const filename =
    kind === 'local' ? PROJECT_CONFIG_LOCAL_PATH : PROJECT_CONFIG_PATH
  return await readJsonFile<Record<string, unknown>>(join(directory, filename))
}

export async function readRawLocalProjectConfig(
  cwd = process.cwd(),
): Promise<Record<string, unknown> | null> {
  return await readJsonFile<Record<string, unknown>>(
    projectConfigLocalPath(cwd),
  )
}

export function configString(value: unknown): string | null {
  return nonEmpty(typeof value === 'string' ? value : undefined) ?? null
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  const text = await readFile(path, 'utf8').catch(() => null)
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
