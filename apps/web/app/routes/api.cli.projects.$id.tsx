import {
  ProjectEditRequestSchema,
  ProjectEditResponseSchema,
  ProjectIdParamsSchema,
} from '@artifactshare/contract'
import { errorResponse } from '~/lib/api-errors'
import {
  cliProjectEditErrorResponse,
  cliProjectResponse,
} from '~/lib/project-actions-adapter.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { withDb } from '~/services/db.server'
import {
  editProjectContainerSettings,
  parseProjectBaseVisibility,
} from '~/services/projects.server'
import type { Route } from './+types/api.cli.projects.$id'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const parsedParams = ProjectIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Project not found.', 404)
  }

  const body = await request.json().catch(() => null)
  const parsedBody = ProjectEditRequestSchema.safeParse(body)
  if (!parsedBody.success) {
    return projectEditValidationError(body, parsedBody.error)
  }
  const input = {
    name: parsedBody.data.name,
    description:
      parsedBody.data.description === null ? '' : parsedBody.data.description,
    baseVisibility:
      parsedBody.data.base_visibility === undefined ||
      parsedBody.data.base_visibility === null
        ? undefined
        : parseProjectBaseVisibility(parsedBody.data.base_visibility),
    addEmails: parsedBody.data.add_emails,
    removeEmails: parsedBody.data.remove_emails,
    archived: parsedBody.data.archived,
  }

  const result = await withDb((db) =>
    editProjectContainerSettings(
      db,
      user.workspaceId,
      parsedParams.data.id,
      user,
      input,
    ),
  )
  if (result.kind !== 'ok') return cliProjectEditErrorResponse(result)
  return Response.json(
    ProjectEditResponseSchema.parse({
      project: cliProjectResponse(result.project),
      audience: result.audience,
    }),
  )
}

function projectEditValidationError(
  body: unknown,
  error: { issues: readonly { path: readonly PropertyKey[] }[] },
): Response {
  if (body === null || typeof body !== 'object') {
    return errorResponse('validation-failed', 'Invalid body.', 400)
  }
  const paths = new Set(error.issues.map((issue) => issue.path[0]))
  if (paths.has('base_visibility')) {
    return errorResponse(
      'validation-failed',
      'Project visibility must be workspace or private.',
      400,
    )
  }
  if (paths.has('name')) {
    return errorResponse('validation-failed', 'Project name is invalid.', 400)
  }
  if (paths.has('description')) {
    return errorResponse(
      'validation-failed',
      'Project description is invalid.',
      400,
    )
  }
  if (paths.has('add_emails') || paths.has('remove_emails')) {
    return errorResponse(
      'validation-failed',
      'Audience emails must be strings.',
      400,
    )
  }
  if (paths.has('archived')) {
    return errorResponse('validation-failed', 'Archived must be boolean.', 400)
  }
  return errorResponse(
    'validation-failed',
    'At least one edit field is required.',
    400,
  )
}
