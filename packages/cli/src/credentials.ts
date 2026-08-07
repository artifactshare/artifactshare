import type {
  CliError,
  CliOptions,
  CredentialSource,
  GlobalConfig,
  ProfileCredentialKind,
  ProjectConfig,
} from './types.js'
import { baseUrlOf, isLocalHostname } from './api.js'
import { CLI_INVOCATION, TOKEN_ENV_VAR } from './constants.js'
import type { ProjectConfigResolution } from './destination.js'
import {
  authRecoveryDetails,
  authRequiredError,
  tokensUrl,
  validationError,
} from './errors.js'
import { nonEmpty, readGlobalConfig, readProfileToken } from './token-store.js'

export type CredentialResolution =
  | {
      ok: true
      token: string
      source: Extract<
        CredentialSource,
        | 'env'
        | 'token_option'
        | 'profile'
        | 'local_config'
        | 'project_config'
        | 'global_profile'
      >
      profile?: string
      profileCredentialKind?: ProfileCredentialKind
      refreshToken?: string
      error?: never
    }
  | {
      ok: false
      source: CredentialSource
      profile?: string
      error: CliError
      token?: never
    }

export async function resolveCredential(
  options: CliOptions,
  projectInput: ProjectConfigResolution | ProjectConfig | null = null,
): Promise<CredentialResolution> {
  const envToken = nonEmpty(process.env.ARTIFACTSHARE_TOKEN)
  const optionToken = nonEmpty(options.token)
  const profile = nonEmpty(options.profile)

  if (profile && (envToken || optionToken)) {
    const source = envToken ? 'env' : 'token_option'
    return {
      ok: false,
      source,
      profile,
      error: validationError(
        'Choose either --profile or a bearer token.',
        'Remove --profile, unset ARTIFACTSHARE_TOKEN, or remove --token before retrying.',
      ),
    }
  }

  if (optionToken) {
    return { ok: true, source: 'token_option', token: optionToken }
  }
  if (envToken) return { ok: true, source: 'env', token: envToken }

  const globalConfig = await readGlobalConfig()
  if (profile) {
    return await resolveProfileCredential(
      'profile',
      profile,
      options,
      globalConfig,
      null,
      null,
    )
  }

  const project = normalizeProjectInput(projectInput)
  const projectProfile = nonEmpty(project.config?.default_profile)
  if (projectProfile) {
    const source = project.kind === 'local' ? 'local_config' : 'project_config'
    return await resolveProfileCredential(
      source,
      projectProfile,
      options,
      globalConfig,
      project.path,
      project.kind,
    )
  }

  const globalProfile = nonEmpty(globalConfig?.default_profile)
  if (globalProfile)
    return await resolveProfileCredential(
      'global_profile',
      globalProfile,
      options,
      globalConfig,
      null,
      null,
    )

  return {
    ok: false,
    source: 'none',
    error: authRequiredError(baseUrlOf(options)),
  }
}

function normalizeProjectInput(
  projectInput: ProjectConfigResolution | ProjectConfig | null,
): ProjectConfigResolution {
  if (!projectInput) {
    return {
      config: null,
      raw: null,
      kind: null,
      path: null,
      directory: null,
    }
  }
  if ('kind' in projectInput) return projectInput
  return {
    config: projectInput,
    raw: projectInput,
    kind: 'shared',
    path: null,
    directory: null,
  }
}

async function resolveProfileCredential(
  source: Extract<
    CredentialSource,
    'profile' | 'local_config' | 'project_config' | 'global_profile'
  >,
  profile: string,
  options: CliOptions,
  globalConfig: GlobalConfig | null,
  configPath: string | null,
  configKind: 'local' | 'shared' | null,
): Promise<CredentialResolution> {
  // A profile is bound to the base URL it logged in against. Adopting it into
  // options here makes both the token-store lookup and every later
  // baseUrlOf() call target that host; explicit --base-url / env still win.
  const profileBaseUrl = nonEmpty(globalConfig?.profiles?.[profile]?.base_url)
  if (
    profileBaseUrl &&
    !nonEmpty(options.baseUrl) &&
    !nonEmpty(process.env.ARTIFACTSHARE_BASE_URL)
  ) {
    options.baseUrl = profileBaseUrl
  }
  const stored = await readProfileToken(profile, options)
  if (stored.ok) {
    return {
      ok: true,
      source,
      profile,
      token: stored.token,
      profileCredentialKind: stored.credential.kind,
      ...(stored.credential.kind === 'session'
        ? { refreshToken: stored.credential.refresh_token }
        : {}),
    }
  }
  return profileAuthRequired(
    source,
    profile,
    stored.reason,
    options,
    globalConfig,
    configPath,
    configKind,
  )
}

async function profileAuthRequired(
  source: Extract<
    CredentialSource,
    'profile' | 'local_config' | 'project_config' | 'global_profile'
  >,
  profile: string,
  reason: 'missing' | 'unavailable' | 'legacy',
  options: CliOptions,
  globalConfig: GlobalConfig | null,
  configPath: string | null,
  configKind: 'local' | 'shared' | null,
): Promise<CredentialResolution> {
  const baseUrl = baseUrlOf(options)
  const url = tokensUrl(baseUrl)
  const error = authRequiredError(baseUrl)
  const why =
    reason === 'unavailable'
      ? `No safe token store is available for profile "${profile}".`
      : reason === 'legacy'
        ? `The saved credential for profile "${profile}" uses an old format.`
        : `No saved credential was found for profile "${profile}".`
  const alternative = await findAlternativeProfileWithToken(
    globalConfig,
    options,
    profile,
  )
  const details: Record<string, unknown> = {
    ...authRecoveryDetails(
      baseUrl,
      `${CLI_INVOCATION} login --profile ${profile}`,
    ),
    credential_source: source,
    profile,
  }
  if (configPath) {
    details.config_path = configPath
    if (configKind) details.config_kind = configKind
  }

  if (alternative) {
    const switchHint = profileSwitchHint(alternative)
    return {
      ok: false,
      source,
      profile,
      error: {
        ...error,
        why,
        hint: `${switchHint} Or in an interactive terminal run ${CLI_INVOCATION} login --profile ${profile}. In agents or CI, issue a token at ${url}, then set ${TOKEN_ENV_VAR}.`,
        agent_recoverable: true,
        requires_human: false,
        recovery: {
          kind: 'run_command',
          command: `${CLI_INVOCATION} profiles use ${alternative}`,
        },
        details: {
          ...details,
          alternative_profile: alternative,
          suggested_profile_command: `${CLI_INVOCATION} profiles use ${alternative}`,
        },
      },
    }
  }

  return {
    ok: false,
    source,
    profile,
    error: {
      ...error,
      why,
      hint: `In an interactive terminal, run ${CLI_INVOCATION} login --profile ${profile}. In agents or CI, issue a token at ${url}, then set ${TOKEN_ENV_VAR}.`,
      details,
    },
  }
}

function profileSwitchHint(profile: string): string {
  return `Run with --profile ${profile}, init --profile ${profile}, or profiles use ${profile}.`
}

async function findAlternativeProfileWithToken(
  globalConfig: GlobalConfig | null,
  options: CliOptions,
  excludeProfile: string,
): Promise<string | null> {
  const profiles = globalConfig?.profiles ?? {}
  const candidates: Array<{ name: string; localDev: boolean }> = []
  for (const name of Object.keys(profiles)) {
    if (name === excludeProfile) continue
    const baseUrl = nonEmpty(profiles[name]?.base_url) ?? baseUrlOf(options)
    candidates.push({ name, localDev: isLocalDevUrl(baseUrl) })
  }
  if (candidates.length === 0) return null
  candidates.sort((left, right) => {
    if (left.localDev !== right.localDev) return left.localDev ? 1 : -1
    return left.name.localeCompare(right.name)
  })
  for (const candidate of candidates) {
    const baseUrl =
      nonEmpty(profiles[candidate.name]?.base_url) ?? baseUrlOf(options)
    const stored = await readProfileToken(candidate.name, {
      ...options,
      baseUrl,
    })
    if (stored.ok) return candidate.name
  }
  return null
}

function isLocalDevUrl(baseUrl: string): boolean {
  try {
    return isLocalHostname(new URL(baseUrl).hostname)
  } catch {
    return false
  }
}

export async function resolveEffectiveDefaultProfile(
  projectInput: ProjectConfigResolution | ProjectConfig | null = null,
): Promise<{
  profile: string | null
  source: 'local' | 'project' | 'global' | 'none'
  path: string | null
}> {
  const project = normalizeProjectInput(projectInput)
  const projectProfile = nonEmpty(project.config?.default_profile)
  if (projectProfile) {
    return {
      profile: projectProfile,
      source: project.kind === 'local' ? 'local' : 'project',
      path: project.path,
    }
  }
  const globalConfig = await readGlobalConfig()
  const globalProfile = nonEmpty(globalConfig?.default_profile)
  if (globalProfile) {
    return { profile: globalProfile, source: 'global', path: null }
  }
  return { profile: null, source: 'none', path: null }
}
