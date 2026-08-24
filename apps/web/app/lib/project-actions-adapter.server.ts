import { errorResponse } from '~/lib/api-errors'
import type {
  EditProjectContainerSettingsResult,
  ProjectSummary,
} from '~/services/projects.server'
import type { DeleteShareableResult } from '~/services/shareables.server'

export function cliProjectResponse(project: ProjectSummary) {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    base_visibility: project.baseVisibility,
    file_count: project.fileCount,
    archived: project.archivedAt !== null,
  }
}

export function cliProjectEditErrorResponse(
  result: Exclude<EditProjectContainerSettingsResult, { kind: 'ok' }>,
): Response {
  switch (result.kind) {
    case 'not-found':
      return errorResponse('not-found', 'Project not found.', 404)
    case 'forbidden':
      return errorResponse('forbidden', 'Not allowed.', 403)
    case 'project-archived':
      return errorResponse(
        'project-archived',
        'Project is archived. Unarchive it before editing settings.',
        409,
      )
    case 'project-name-conflict':
      return errorResponse(
        'project-name-conflict',
        'An active project with this name already exists.',
        409,
      )
    case 'project-limit-reached':
      return errorResponse(
        'project-limit-reached',
        `You've reached your plan's project limit (${result.limit} projects). Upgrade your plan or archive existing projects. See /settings/billing for upgrade options.`,
        403,
      )
    case 'too-many-grants':
      return errorResponse(
        'too-many-grants',
        'Too many project audience members.',
        400,
      )
    case 'validation-failed':
      return errorResponse('validation-failed', 'Invalid project input.', 400)
    case 'bot-grant-rejected':
      return errorResponse(
        result.code,
        result.code === 'bot-stopped-grant-rejected'
          ? 'This bot has been stopped and cannot receive grants.'
          : 'This grant change is not allowed for a bot.',
        400,
      )
  }
}

export function deleteArtifactSuccessBody(id: string) {
  return { id, deleted: true }
}

export function cliDeleteArtifactErrorResponse(
  result: Exclude<DeleteShareableResult, { kind: 'ok' }>,
): Response {
  switch (result.kind) {
    case 'not-found':
      return errorResponse('not-found', 'Artifact not found.', 404)
    case 'delete-failed':
      return errorResponse(
        'delete-failed',
        'Could not delete the artifact.',
        502,
      )
  }
}
