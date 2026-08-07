import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  ArtifactVisibility,
  CliError,
  ConfigKey,
  HomeAudienceConfigKey,
  OutputMode,
  ParsedArgs,
} from '../types.js'
import {
  PROJECT_CONFIG_PATH,
  resolveHomeVisibility,
  resolveDefaultVisibility,
  resolveSharedProjectConfig,
  resolveVisibility,
} from '../destination.js'
import { configHome, writeGlobalConfig } from '../token-store.js'
import { validationError } from '../errors.js'
import { writeFailure, writeSuccess } from '../output.js'
import { isRecord } from '../validators.js'

const KEYS: ConfigKey[] = ['home_audience', 'default_project_visibility']
const ACCEPTED_KEYS: ConfigKey[] = [
  'home_audience',
  'default_artifact_visibility',
  'default_project_visibility',
]
const SCOPES = ['user', 'repository'] as const
type Scope = (typeof SCOPES)[number]

function keyOf(value: string | undefined): ConfigKey | null {
  if (value === 'default_artifact_visibility') return value
  return KEYS.includes(value as ConfigKey) ? (value as ConfigKey) : null
}

function isHomeKey(key: ConfigKey): key is HomeAudienceConfigKey {
  return key === 'home_audience' || key === 'default_artifact_visibility'
}

function logicalValue(
  config: Record<string, unknown>,
  key: ConfigKey,
): unknown {
  if (isHomeKey(key)) {
    return Object.hasOwn(config, 'home_audience')
      ? config.home_audience
      : config.default_artifact_visibility
  }
  return config[key]
}

function withConfigValue(
  config: Record<string, unknown>,
  key: ConfigKey,
  value: ArtifactVisibility | null,
): Record<string, unknown> {
  const next = { ...config }
  if (isHomeKey(key)) {
    delete next.default_artifact_visibility
    if (value === null) delete next.home_audience
    else next.home_audience = value
  } else if (value === null) delete next[key]
  else next[key] = value
  return next
}

function scopeOf(value: string | undefined): Scope | null {
  return SCOPES.includes(value as Scope) ? (value as Scope) : null
}

function invalid(message: string, hint: string) {
  return validationError(message, hint, 'validation_failed')
}

function invalidConfiguredValue(
  scope: Scope,
  key: ConfigKey,
  value: unknown,
): CliError | null {
  if (value === undefined || value === 'workspace' || value === 'private') {
    return null
  }
  return invalid(
    `${scope === 'repository' ? 'Repository' : 'User'} ${isHomeKey(key) ? 'home_audience' : key} must be workspace or private.`,
    `Fix the ${scope} config before using this setting.`,
  )
}

function selectedKeys(positionals: string[]): ConfigKey[] | null {
  if (positionals.length === 0) return ['home_audience']
  const key = keyOf(positionals[0])
  return key && positionals.length === 1 ? [key] : null
}

async function readUserConfig(): Promise<
  { config: Record<string, unknown> } | { error: CliError }
> {
  const home = configHome()
  if (!home) return { config: {} }
  const path = join(home, 'config.json')
  try {
    const text = await readFile(path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        error: invalid(
          'User config contains invalid JSON.',
          `Fix ${path} before reading user settings.`,
        ),
      }
    }
    if (!isRecord(parsed)) {
      return {
        error: invalid(
          'User config must contain a JSON object.',
          `Fix ${path} before reading user settings.`,
        ),
      }
    }
    return { config: parsed }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { config: {} }
    return {
      error: invalid(
        'User config could not be read.',
        `Check access to ${path} before reading user settings.`,
      ),
    }
  }
}

export async function runConfigGet(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'config get'
  const keys = selectedKeys(parsed.positionals)
  if (!keys)
    return writeFailure(
      command,
      invalid(
        'Unknown config key.',
        `Use one of: ${ACCEPTED_KEYS.join(', ')}.`,
      ),
      mode,
      1,
    )
  const scope = parsed.options.scope
  if (
    scope !== undefined &&
    !['user', 'repository', 'effective'].includes(scope)
  ) {
    return writeFailure(
      command,
      invalid(
        'Scope must be user, repository, or effective.',
        'Pass --scope user, --scope repository, or --scope effective.',
      ),
      mode,
      1,
    )
  }
  const effective = scope === undefined || scope === 'effective'
  const shared = await resolveSharedProjectConfig()
  if (scope === 'repository' && shared.error) {
    return writeFailure(command, shared.error, mode, 1)
  }
  const user = scope === 'user' ? await readUserConfig() : { config: {} }
  if ('error' in user) return writeFailure(command, user.error, mode, 1)
  const data: Record<string, unknown> = {}
  for (const key of keys) {
    if (effective) {
      const item = await resolveDefaultVisibility(key, shared)
      if ('error' in item) return writeFailure(command, item.error, mode, 1)
      data[key] = item
    } else {
      const scoped: Scope = scope === 'repository' ? 'repository' : 'user'
      const raw =
        scoped === 'repository'
          ? logicalValue(shared.config ?? {}, key)
          : logicalValue(user.config, key)
      const valueError = invalidConfiguredValue(scoped, key, raw)
      if (valueError) return writeFailure(command, valueError, mode, 1)
      data[key] = {
        value: raw === 'workspace' || raw === 'private' ? raw : null,
        source: scoped,
      }
    }
  }
  return writeSuccess(command, data, mode)
}

async function writeRepository(
  key: ConfigKey,
  value: ArtifactVisibility | null,
): Promise<{ path: string } | { error: CliError }> {
  let directory = resolve(process.cwd())
  const root = resolve(directory, '/')
  let path = join(directory, PROJECT_CONFIG_PATH)
  let current: Record<string, unknown> = {}

  while (true) {
    path = join(directory, PROJECT_CONFIG_PATH)
    try {
      const text = await readFile(path, 'utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return {
          error: invalid(
            'Repository config contains invalid JSON.',
            `Fix ${path} before changing repository settings.`,
          ),
        }
      }
      if (!isRecord(parsed)) {
        return {
          error: invalid(
            'Repository config must contain a JSON object.',
            `Fix ${path} before changing repository settings.`,
          ),
        }
      }
      current = parsed
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          error: invalid(
            'Repository config could not be read.',
            `Check access to ${path} before changing repository settings.`,
          ),
        }
      }
    }
    if (directory === root) {
      directory = resolve(process.cwd())
      path = join(directory, PROJECT_CONFIG_PATH)
      break
    }
    directory = dirname(directory)
  }

  const next = withConfigValue(current, key, value)
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    return {
      error: invalid(
        'Repository config could not be written.',
        `Check access to ${path} before changing repository settings.`,
      ),
    }
  }
  return { path }
}

async function writeConfig(
  scope: Scope,
  key: ConfigKey,
  value: ArtifactVisibility | null,
): Promise<{ path: string } | { path: null } | { error: CliError }> {
  if (scope === 'repository') return writeRepository(key, value)
  const home = configHome()
  if (!home) return { path: null }
  const path = join(home, 'config.json')
  let current: Record<string, unknown> = {}
  try {
    const text = await readFile(path, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return {
        error: invalid(
          'User config contains invalid JSON.',
          `Fix ${path} before changing user settings.`,
        ),
      }
    }
    if (!isRecord(parsed)) {
      return {
        error: invalid(
          'User config must contain a JSON object.',
          `Fix ${path} before changing user settings.`,
        ),
      }
    }
    current = parsed
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        error: invalid(
          'User config could not be read.',
          `Check access to ${path} before changing user settings.`,
        ),
      }
    }
  }
  const next = withConfigValue(current, key, value)
  try {
    if (!(await writeGlobalConfig(next))) return { path: null }
  } catch {
    return {
      error: invalid(
        'User config could not be written.',
        `Check access to ${path} before changing user settings.`,
      ),
    }
  }
  return { path }
}

async function runMutation(
  parsed: ParsedArgs,
  mode: OutputMode,
  unset: boolean,
): Promise<void> {
  const command = unset ? 'config unset' : 'config set'
  const key = keyOf(parsed.positionals[0])
  const value = parsed.positionals[1]
  const scope = scopeOf(parsed.options.scope)
  if (!key)
    return writeFailure(
      command,
      invalid(
        'Unknown config key.',
        `Use one of: ${ACCEPTED_KEYS.join(', ')}.`,
      ),
      mode,
      1,
    )
  if (!scope)
    return writeFailure(
      command,
      invalid(
        '--scope is required and must be user or repository.',
        'Pass --scope user or --scope repository.',
      ),
      mode,
      1,
    )
  if (
    unset ? parsed.positionals.length !== 1 : parsed.positionals.length !== 2
  ) {
    return writeFailure(
      command,
      invalid(
        unset
          ? 'A single config key is required.'
          : 'A config key and value are required.',
        `Use ${command} <key>${unset ? '' : ' <workspace|private>'} --scope ${scope}.`,
      ),
      mode,
      1,
    )
  }
  if (!unset && value !== 'workspace' && value !== 'private') {
    return writeFailure(
      command,
      invalid(
        'Config value must be workspace or private.',
        'Use workspace or private.',
      ),
      mode,
      1,
    )
  }
  const shared = await resolveSharedProjectConfig()
  if (shared.error) return writeFailure(command, shared.error, mode, 1)
  const user =
    scope === 'repository' && !unset
      ? { config: {} as Record<string, unknown> }
      : await readUserConfig()
  if ('error' in user) return writeFailure(command, user.error, mode, 1)
  if (scope !== 'repository') {
    const repositoryValueError = invalidConfiguredValue(
      'repository',
      key,
      logicalValue(shared.config ?? {}, key),
    )
    if (repositoryValueError) {
      return writeFailure(command, repositoryValueError, mode, 1)
    }
  }
  if (scope === 'repository' && unset) {
    const userValueError = invalidConfiguredValue(
      'user',
      key,
      logicalValue(user.config, key),
    )
    if (userValueError) return writeFailure(command, userValueError, mode, 1)
  }
  const writtenValue = unset ? null : (value as ArtifactVisibility)
  const written = await writeConfig(scope, key, writtenValue)
  if ('error' in written) return writeFailure(command, written.error, mode, 1)
  if (!written.path)
    return writeFailure(
      command,
      invalid(
        'The config store is unavailable.',
        'Set ARTIFACTSHARE_CONFIG_HOME to a writable directory.',
      ),
      mode,
      1,
    )
  const repositoryConfig =
    scope === 'repository'
      ? withConfigValue(shared.config ?? {}, key, writtenValue)
      : (shared.config ?? {})
  const userConfig =
    scope === 'user'
      ? withConfigValue(user.config, key, writtenValue)
      : user.config
  const repositoryValue = logicalValue(repositoryConfig, key)
  const userValue = logicalValue(userConfig, key)
  const item = isHomeKey(key)
    ? resolveHomeVisibility(
        undefined,
        repositoryConfig.home_audience,
        repositoryConfig.default_artifact_visibility,
        userConfig.home_audience,
        userConfig.default_artifact_visibility,
      )
    : resolveVisibility(undefined, repositoryValue, userValue)
  if ('invalid' in item) {
    return writeFailure(
      command,
      invalid(
        'Config value must be workspace or private.',
        'Fix the config before using this setting.',
      ),
      mode,
      1,
    )
  }
  return writeSuccess(command, { scope, path: written.path, [key]: item }, mode)
}

export function runConfigSet(parsed: ParsedArgs, mode: OutputMode) {
  return runMutation(parsed, mode, false)
}

export function runConfigUnset(parsed: ParsedArgs, mode: OutputMode) {
  return runMutation(parsed, mode, true)
}
