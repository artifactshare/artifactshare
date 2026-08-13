import type {
  ApiBody,
  ConfigValueSource,
  DoctorConfigData,
  DoctorConfigEffectiveData,
  DoctorConfigFileData,
  AuthRecoveryData,
  DoctorData,
  OutputMode,
  ParsedArgs,
} from '../types.js'
import { apiUrl, baseUrlOf, cliFetch, readJson, requestConfig } from '../api.js'
import { CLI_INVOCATION } from '../constants.js'
import { resolveCredential } from '../credentials.js'
import {
  configString,
  PROJECT_CONFIG_LOCAL_PATH,
  PROJECT_CONFIG_PATH,
  readProjectConfigAtDirectory,
  relativeProjectConfigPath,
  resolveProjectConfig,
  resolveDestination,
} from '../destination.js'
import {
  mapApiError,
  networkError,
  normalizeApiCode,
  authRecoveryDetails,
  uploadBlockedHint,
} from '../errors.js'
import { writeFailure, writeSuccess } from '../output.js'
import { readGlobalConfig } from '../token-store.js'
import { runAuthenticatedApi } from './auto-login.js'
import { skillDiagnostics } from './skills.js'

const LOGIN_COMMAND = `${CLI_INVOCATION} login`

type DoctorApiData =
  | { kind: 'network_failed'; hint: string }
  | { kind: 'body'; body: ApiBody | null }

type DoctorAuthority = {
  preset: 'unrestricted' | 'agent'
  project_id: string | null
}

function bearerTokenBlocksLogin(data: DoctorData): boolean {
  return (
    data.auth.credential_source === 'env' ||
    data.auth.credential_source === 'token_option'
  )
}

function resolveDoctorNextCommand(data: DoctorData): string | null {
  if (data.config.local.code === 'token_store_unsafe') {
    if (bearerTokenBlocksLogin(data)) return null
    return LOGIN_COMMAND
  }
  if (data.config.project.code === 'token_store_unsafe') {
    if (bearerTokenBlocksLogin(data)) return null
    return LOGIN_COMMAND
  }
  if (
    (data.auth.code === 'auth_required' ||
      data.auth.code === 'token_invalid') &&
    !bearerTokenBlocksLogin(data)
  ) {
    return data.auth.profile
      ? `${LOGIN_COMMAND} --profile ${data.auth.profile}`
      : LOGIN_COMMAND
  }
  if (data.destination.ok && data.destination.code === 'agent_scope_mismatch') {
    return data.destination.approved_project_id && data.auth.profile
      ? `${CLI_INVOCATION} init --profile ${data.auth.profile} --project-id ${data.destination.approved_project_id} --json`
      : null
  }
  return null
}

function authRecovery(
  data: DoctorData,
  nextCommand: string | null,
): AuthRecoveryData {
  const loginCommand =
    nextCommand?.startsWith(LOGIN_COMMAND) === true
      ? nextCommand
      : data.auth.profile
        ? `${LOGIN_COMMAND} --profile ${data.auth.profile}`
        : LOGIN_COMMAND
  return authRecoveryDetails(data.base_url, loginCommand)
}

function doctorDataWithNextCommand(data: DoctorData): DoctorData {
  const nextCommand = resolveDoctorNextCommand(data)
  const next = { ...data, next_command: nextCommand }
  if (next.auth.code === 'auth_required') {
    next.auth = { ...next.auth, recovery: authRecovery(next, nextCommand) }
  }
  return next
}

export async function runDoctor(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'doctor'
  const project = await resolveProjectConfig()
  const credential = await resolveCredential(parsed.options, project)
  const destination = resolveDestination(parsed.options, project.config)
  const data: DoctorData = {
    next_command: null,
    base_url: baseUrlOf(parsed.options),
    config: await configDiagnostics(project),
    skills: await skillDiagnostics(),
    auth: {
      credential_source: credential.source,
      ...(credential.profile ? { profile: credential.profile } : {}),
      ...(credential.ok && credential.botProfile
        ? { profile_kind: 'bot' as const }
        : {}),
      token_present: credential.ok,
      ok: false,
    },
    destination: destination.error
      ? {
          ok: false,
          code: destination.error.code,
          hint: destination.error.hint,
        }
      : {
          ok: true,
          type: destination.containerId ? 'project' : 'home',
          project_id: destination.containerId ?? null,
        },
    network: { ok: false },
    upload: { ok: false, checked: false },
  }

  if (!credential.ok) {
    if (credential.error.code !== 'auth_required') {
      return writeFailure(command, credential.error, mode, 1)
    }
    data.auth.code = credential.error.code
    data.auth.hint = credential.error.hint
    return writeSuccess(command, doctorDataWithNextCommand(data), mode)
  }
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const result = await runAuthenticatedApi<DoctorApiData>(
    credential,
    parsed.options,
    async (current) => {
      const response = await cliFetch(
        apiUrl('/api/cli/doctor', baseUrlOf(parsed.options)),
        {
          headers: { Authorization: `Bearer ${current.token}` },
          ...request.init,
        },
      )
      if ('networkError' in response) {
        return {
          data: {
            kind: 'network_failed' as const,
            hint: networkError(response.networkError).hint,
          },
        }
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
      return { data: { kind: 'body' as const, body } }
    },
  )
  if (result.error) {
    const authError = result.refreshError
      ? (result.originalError ?? result.error)
      : result.error
    if (result.refreshError?.code === 'network_failed') {
      data.network = {
        ok: false,
        code: 'network_failed',
        hint: result.refreshError.hint,
      }
    } else {
      data.network.ok = true
    }
    data.auth.code = authError.code
    data.auth.hint = authError.hint
    return writeSuccess(command, doctorDataWithNextCommand(data), mode)
  }
  if (result.data.kind === 'network_failed') {
    data.network = {
      ok: false,
      code: 'network_failed',
      hint: result.data.hint,
    }
    return writeSuccess(command, doctorDataWithNextCommand(data), mode)
  }

  data.network.ok = true
  const body = result.data.body

  if (!body) throw new Error('Doctor response was not valid JSON.')

  data.auth.ok = body.auth?.ok ?? true
  data.auth.email = body.user?.email ?? null
  const authority = doctorAuthority(body.auth?.authority)
  if (authority) data.auth.authority = authority
  applyAgentDestinationDiagnostic(data, authority)
  data.upload.checked = true
  data.upload.ok = body.upload?.ok ?? false
  if (!data.upload.ok) {
    data.upload.code = normalizeApiCode(body.upload?.code)
    data.upload.hint = uploadBlockedHint(data.upload.code)
  }
  return writeSuccess(command, doctorDataWithNextCommand(data), mode)
}

function doctorAuthority(value: unknown): DoctorAuthority | null {
  if (!value || typeof value !== 'object') return null
  const authority = value as Record<string, unknown>
  if (
    authority.preset === 'agent' &&
    typeof authority.project_id === 'string' &&
    authority.project_id
  ) {
    return { preset: 'agent', project_id: authority.project_id }
  }
  if (
    authority.preset === 'unrestricted' &&
    (authority.project_id === null || authority.project_id === undefined)
  ) {
    return { preset: 'unrestricted', project_id: null }
  }
  return null
}

function applyAgentDestinationDiagnostic(
  data: DoctorData,
  authority: DoctorAuthority | null,
): void {
  if (
    authority?.preset !== 'agent' ||
    !authority.project_id ||
    !data.destination.ok ||
    data.destination.project_id === authority.project_id
  ) {
    return
  }
  data.destination = {
    ok: true,
    type: data.destination.type,
    project_id: data.destination.project_id,
    approved_project_id: authority.project_id,
    code: 'agent_scope_mismatch',
    hint: data.auth.profile
      ? `The configured default destination is outside this agent credential's approved project. Run ${CLI_INVOCATION} init --profile ${data.auth.profile} --project-id ${authority.project_id} --json to use the approved project by default.`
      : `The configured default destination is outside this agent credential's approved project. Pass --project-id ${authority.project_id} when sharing.`,
  }
}

async function configDiagnostics(
  project: Awaited<ReturnType<typeof resolveProjectConfig>>,
): Promise<DoctorConfigData> {
  const globalConfig = await readGlobalConfig()
  const cwd = process.cwd()
  const directory = project.directory
  const localRaw = directory
    ? await readProjectConfigAtDirectory(directory, 'local')
    : null
  const sharedRaw = directory
    ? await readProjectConfigAtDirectory(directory, 'shared')
    : null

  return {
    local: fileDiagnostics(
      localRaw,
      directory
        ? relativeProjectConfigPath(cwd, directory, PROJECT_CONFIG_LOCAL_PATH)
        : null,
    ),
    project: fileDiagnostics(
      sharedRaw,
      directory
        ? relativeProjectConfigPath(cwd, directory, PROJECT_CONFIG_PATH)
        : null,
    ),
    global: {
      present: globalConfig !== null,
      default_profile: configString(globalConfig?.default_profile),
      profile_count: Object.keys(globalConfig?.profiles ?? {}).length,
    },
    effective: effectiveDiagnostics(project, globalConfig),
  }
}

function fileDiagnostics(
  raw: Record<string, unknown> | null,
  path: string | null,
): DoctorConfigFileData {
  const unsafeKey = Object.keys(raw ?? {}).find((key) =>
    key.toLowerCase().includes('token'),
  )
  return {
    present: raw !== null,
    path,
    default_profile: configString(raw?.default_profile),
    default_project_id: configString(raw?.default_project_id),
    ...(unsafeKey
      ? {
          code: 'token_store_unsafe',
          hint: `Remove "${unsafeKey}" from ${path ?? 'the working-directory config'} and run ${CLI_INVOCATION} login instead; the working-directory config must never hold secrets.`,
        }
      : {}),
  }
}

function effectiveDiagnostics(
  project: Awaited<ReturnType<typeof resolveProjectConfig>>,
  globalConfig: Awaited<ReturnType<typeof readGlobalConfig>>,
): DoctorConfigEffectiveData {
  const projectProfile = configString(project.config?.default_profile)
  const projectProjectId = configString(project.config?.default_project_id)
  const globalProfile = configString(globalConfig?.default_profile)

  const defaultProfile = projectProfile ?? globalProfile
  const defaultProfileSource: ConfigValueSource = projectProfile
    ? project.kind === 'local'
      ? 'local'
      : 'project'
    : globalProfile
      ? 'global'
      : 'none'
  const defaultProfilePath =
    defaultProfileSource === 'local' || defaultProfileSource === 'project'
      ? project.path
      : null

  const defaultProjectId = projectProjectId
  const defaultProjectIdSource: ConfigValueSource = projectProjectId
    ? project.kind === 'local'
      ? 'local'
      : 'project'
    : 'none'
  const defaultProjectIdPath =
    defaultProjectIdSource === 'local' || defaultProjectIdSource === 'project'
      ? project.path
      : null

  return {
    default_profile: defaultProfile,
    default_profile_source: defaultProfileSource,
    default_profile_path: defaultProfilePath,
    default_project_id: defaultProjectId,
    default_project_id_source: defaultProjectIdSource,
    default_project_id_path: defaultProjectIdPath,
  }
}
