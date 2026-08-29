import type {
  ApiErrorOptions,
  CliError,
  CliOptions,
  OutputMode,
  ParsedArgs,
  ProjectsCreateData,
  ProjectsEditData,
  ProjectsListData,
  ProjectsListEntry,
} from '../types.js'
import { apiGet, apiPost, requestConfig } from '../api.js'
import { resolveCredential } from '../credentials.js'
import {
  configString,
  resolveDefaultVisibility,
  resolveProjectConfig,
  resolveSharedProjectConfig,
} from '../destination.js'
import { serviceError, validationError } from '../errors.js'
import { writeFailure, writeSuccess, writeText } from '../output.js'
import { arrayOption } from '../shared.js'
import { isRecord } from '../validators.js'
import { runAuthenticatedApi } from './auto-login.js'

export type FetchedProject = {
  id: string
  name: string | null
  description: string | null
  base_visibility: string | null
  file_count: number | null
  updated_at: string | null
}

export async function fetchProjects(
  token: string,
  options: CliOptions,
  init: Parameters<typeof apiGet>[3],
  errorOptions: ApiErrorOptions = {},
): Promise<
  | { projects: FetchedProject[]; error?: never }
  | { error: CliError; projects?: never }
> {
  const result = await apiGet(
    '/api/cli/projects',
    token,
    options,
    init,
    errorOptions,
  )
  if (result.error) return { error: result.error }

  const rawProjects = Array.isArray(result.body?.projects)
    ? result.body.projects
    : []
  const projects: FetchedProject[] = rawProjects
    .filter(isRecord)
    .flatMap((project) => {
      const id = configString(project.id)
      if (!id) return []
      return [
        {
          id,
          name: configString(project.name),
          description: configString(project.description),
          base_visibility: configString(project.base_visibility),
          file_count:
            typeof project.file_count === 'number' ? project.file_count : null,
          updated_at: configString(project.updated_at),
        },
      ]
    })
  return { projects }
}

export async function runProjectsList(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'projects list'
  const projectConfig = await resolveProjectConfig()
  const credential = await resolveCredential(parsed.options, projectConfig)
  if (!credential.ok) return writeFailure(command, credential.error, mode, 1)
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const fetched = await fetchProjects(
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
      return fetched.error
        ? { error: fetched.error }
        : { data: fetched.projects }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)

  const defaultProjectId = configString(
    projectConfig.config?.default_project_id,
  )
  const projects: ProjectsListEntry[] = result.data.map((project) => ({
    ...project,
    is_default: project.id === defaultProjectId,
  }))
  const data: ProjectsListData = {
    default_project_id: defaultProjectId,
    projects,
  }
  writeSuccess(command, data, mode)
  if (!mode.json && projects.length === 0) {
    writeText(
      'No projects yet. Create one on the web, then share with --project-id.\n',
    )
  }
}

export async function runProjectsCreate(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'projects create'
  const name = parsed.positionals[0]?.trim()
  if (!name) {
    return writeFailure(
      command,
      validationError(
        'Project name is required.',
        'Pass a project name: projects create <name>.',
      ),
      mode,
      1,
    )
  }
  const visibility = parsed.options.visibility
  if (
    visibility !== undefined &&
    visibility !== 'workspace' &&
    visibility !== 'private'
  ) {
    return writeFailure(
      command,
      validationError(
        '--visibility must be workspace or private.',
        'Retry with --visibility workspace or --visibility private.',
      ),
      mode,
      1,
    )
  }

  const projectConfig = await resolveProjectConfig()
  const defaultVisibility = visibility
    ? null
    : await resolveDefaultVisibility(
        'default_project_visibility',
        await resolveSharedProjectConfig(),
      )
  if (defaultVisibility && 'error' in defaultVisibility) {
    return writeFailure(command, defaultVisibility.error, mode, 1)
  }
  const credential = await resolveCredential(parsed.options, projectConfig)
  if (!credential.ok) return writeFailure(command, credential.error, mode, 1)
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const created = await apiPost(
        '/api/cli/projects',
        current.token,
        {
          name,
          description: parsed.options.description ?? null,
          base_visibility: visibility ?? defaultVisibility!.value,
        },
        parsed.options,
        request.init,
        {
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
          botProfile: current.botProfile,
        },
      )
      return created.error ? { error: created.error } : { data: created.body }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)

  const project = isRecord(result.data?.project) ? result.data.project : null
  const id = configString(project?.id)
  if (!id) {
    return writeFailure(
      command,
      serviceError('Project create succeeded but no project id was returned.'),
      mode,
      1,
    )
  }

  const data: ProjectsCreateData = {
    project: {
      id,
      name: configString(project?.name),
      description: configString(project?.description),
      base_visibility: configString(project?.base_visibility),
    },
    next_command: `npm exec --yes --package=@artifactshare/cli -- artifactshare share <path> --project-id ${id} --json`,
  }
  writeSuccess(command, data, mode)
}

export async function runProjectsEdit(
  parsed: ParsedArgs,
  mode: OutputMode,
): Promise<void> {
  const command = 'projects edit'
  const projectId = parsed.positionals[0]?.trim()
  if (!projectId) {
    return writeFailure(
      command,
      validationError(
        'Project id is required.',
        'Pass a project id: projects edit <id>.',
      ),
      mode,
      1,
    )
  }

  const payload = buildProjectsEditPayload(parsed)
  if (payload.error) return writeFailure(command, payload.error, mode, 1)

  const projectConfig = await resolveProjectConfig()
  const credential = await resolveCredential(parsed.options, projectConfig)
  if (!credential.ok) return writeFailure(command, credential.error, mode, 1)
  const request = await requestConfig(parsed.options)
  if (request.error) return writeFailure(command, request.error, mode, 1)

  const result = await runAuthenticatedApi(
    credential,
    parsed.options,
    async (current) => {
      const edited = await apiPost(
        `/api/cli/projects/${encodeURIComponent(projectId)}`,
        current.token,
        payload.body,
        parsed.options,
        request.init,
        {
          projectTarget: true,
          credentialSource: current.source,
          profile: current.profile,
          profileCredentialKind: current.profileCredentialKind,
          botProfile: current.botProfile,
        },
      )
      return edited.error ? { error: edited.error } : { data: edited.body }
    },
  )
  if (result.error) return writeFailure(command, result.error, mode, 1)

  const data = parseProjectsEditData(result.data)
  if (!data) {
    return writeFailure(
      command,
      serviceError(
        'Project edit succeeded but the response did not include project data.',
      ),
      mode,
      1,
    )
  }
  writeSuccess(command, data, mode)
}

function buildProjectsEditPayload(
  parsed: ParsedArgs,
):
  | { body: Record<string, unknown>; error?: never }
  | { error: ReturnType<typeof validationError>; body?: never } {
  const body: Record<string, unknown> = {}
  let hasChange = false

  if (parsed.options.name !== undefined) {
    const name = parsed.options.name.trim()
    if (!name) {
      return {
        error: validationError(
          '--name must not be blank.',
          'Retry with a non-empty project name.',
        ),
      }
    }
    body.name = name
    hasChange = true
  }

  if (parsed.options.description !== undefined) {
    body.description = parsed.options.description
    hasChange = true
  }

  if (parsed.options.visibility !== undefined) {
    const visibility = parsed.options.visibility.trim()
    if (visibility !== 'workspace' && visibility !== 'private') {
      return {
        error: validationError(
          '--visibility must be workspace or private.',
          'Retry with --visibility workspace or --visibility private.',
        ),
      }
    }
    body.base_visibility = visibility
    hasChange = true
  }

  const addEmails = normalizedEmailOptions(parsed.options.addEmail)
  if (addEmails.error) return { error: addEmails.error }
  if (parsed.options.addEmail !== undefined) {
    body.add_emails = addEmails.values
    hasChange = true
  }

  const removeEmails = normalizedEmailOptions(parsed.options.removeEmail)
  if (removeEmails.error) return { error: removeEmails.error }
  if (parsed.options.removeEmail !== undefined) {
    body.remove_emails = removeEmails.values
    hasChange = true
  }

  if (parsed.options.archive && parsed.options.unarchive) {
    return {
      error: validationError(
        'Archive state is conflicting.',
        'Choose either --archive or --unarchive.',
      ),
    }
  }
  if (parsed.options.archive) {
    body.archived = true
    hasChange = true
  }
  if (parsed.options.unarchive) {
    body.archived = false
    hasChange = true
  }

  if (!hasChange) {
    return {
      error: validationError(
        'At least one project edit option is required.',
        'Pass --name, --description, --visibility, --add-email, --remove-email, --archive, or --unarchive.',
      ),
    }
  }

  return { body }
}

function normalizedEmailOptions(
  value: string | string[] | undefined,
):
  | { values: string[]; error?: never }
  | { error: ReturnType<typeof validationError>; values?: never } {
  const values = arrayOption(value)
    .map((email) => email.trim())
    .filter(Boolean)
  if (value !== undefined && values.length === 0) {
    return {
      error: validationError(
        'Email option must not be blank.',
        'Pass a non-empty email address.',
      ),
    }
  }
  return { values }
}

function parseProjectsEditData(body: unknown): ProjectsEditData | null {
  if (!isRecord(body) || !isRecord(body.project)) return null
  const { project } = body
  if (
    typeof project.id !== 'string' ||
    typeof project.archived !== 'boolean' ||
    !Array.isArray(body.audience) ||
    body.audience.some((email) => typeof email !== 'string')
  ) {
    return null
  }
  return {
    project: {
      id: project.id,
      name: configString(project.name),
      description: configString(project.description),
      base_visibility: configString(project.base_visibility),
      file_count:
        typeof project.file_count === 'number' ? project.file_count : null,
      archived: project.archived,
    },
    audience: body.audience,
  }
}
