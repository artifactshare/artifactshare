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

type ProjectEditBody = {
  name?: unknown
  description?: unknown
  base_visibility?: unknown
  add_emails?: unknown
  remove_emails?: unknown
  archived?: unknown
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)

  const body = (await request
    .json()
    .catch(() => null)) as ProjectEditBody | null
  const input = parseProjectEditBody(body)
  if (input.error) return input.error

  const result = await withDb((db) =>
    editProjectContainerSettings(db, user.workspaceId, params.id, user, input),
  )
  if (result.kind !== 'ok') return cliProjectEditErrorResponse(result)
  return Response.json({
    project: cliProjectResponse(result.project),
    audience: result.audience,
  })
}

function parseProjectEditBody(body: ProjectEditBody | null):
  | {
      name?: string
      description?: string
      baseVisibility?: 'workspace' | 'private'
      addEmails?: string[]
      removeEmails?: string[]
      archived?: boolean
      error?: never
    }
  | { error: Response } {
  if (!body || typeof body !== 'object') {
    return { error: errorResponse('validation-failed', 'Invalid body.', 400) }
  }
  if (
    body.base_visibility !== undefined &&
    body.base_visibility !== null &&
    body.base_visibility !== 'workspace' &&
    body.base_visibility !== 'private'
  ) {
    return {
      error: errorResponse(
        'validation-failed',
        'Project visibility must be workspace or private.',
        400,
      ),
    }
  }
  if (body.name !== undefined && typeof body.name !== 'string') {
    return {
      error: errorResponse(
        'validation-failed',
        'Project name is invalid.',
        400,
      ),
    }
  }
  if (
    body.description !== undefined &&
    typeof body.description !== 'string' &&
    body.description !== null
  ) {
    return {
      error: errorResponse(
        'validation-failed',
        'Project description is invalid.',
        400,
      ),
    }
  }
  const addEmails = optionalStringArray(body.add_emails)
  const removeEmails = optionalStringArray(body.remove_emails)
  if (addEmails === null || removeEmails === null) {
    return {
      error: errorResponse(
        'validation-failed',
        'Audience emails must be strings.',
        400,
      ),
    }
  }
  if (body.archived !== undefined && typeof body.archived !== 'boolean') {
    return {
      error: errorResponse(
        'validation-failed',
        'Archived must be boolean.',
        400,
      ),
    }
  }

  const hasChange =
    body.name !== undefined ||
    body.description !== undefined ||
    body.base_visibility !== undefined ||
    addEmails !== undefined ||
    removeEmails !== undefined ||
    body.archived !== undefined
  if (!hasChange) {
    return {
      error: errorResponse(
        'validation-failed',
        'At least one edit field is required.',
        400,
      ),
    }
  }

  return {
    name: typeof body.name === 'string' ? body.name : undefined,
    description:
      typeof body.description === 'string'
        ? body.description
        : body.description === null
          ? ''
          : undefined,
    baseVisibility:
      body.base_visibility === undefined || body.base_visibility === null
        ? undefined
        : parseProjectBaseVisibility(body.base_visibility),
    addEmails,
    removeEmails,
    archived: body.archived,
  }
}

function optionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  if (value.some((item) => typeof item !== 'string')) return null
  return value
}
