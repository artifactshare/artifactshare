import { errorResponse } from '~/lib/api-errors'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  archiveProjectContainer,
  deleteProjectContainer,
  unarchiveProjectContainer,
  type ProjectArchiveResult,
  type ProjectUnarchiveResult,
} from '~/services/projects.server'
import type { Route } from './+types/api.projects.$id'

export const middleware = [requireUserApiMiddleware]

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const body = (await request.json().catch(() => null)) as {
    action?: unknown
  } | null
  const op = body?.action
  const db = createDb()

  if (op === 'archive') {
    return mapArchiveResult(
      await archiveProjectContainer(db, user.workspaceId, params.id, user.id),
    )
  }
  if (op === 'unarchive') {
    return mapUnarchiveResult(
      await unarchiveProjectContainer(db, user.workspaceId, params.id, user.id),
    )
  }
  if (op === 'delete') {
    const result = await deleteProjectContainer(
      db,
      user.workspaceId,
      params.id,
      user.id,
    )
    if (result === 'not-found') {
      return errorResponse('not-found', 'Project not found.', 404)
    }
    if (result === 'forbidden') {
      return errorResponse('forbidden', 'Not allowed.', 403)
    }
    if (result === 'not-empty') {
      return errorResponse('not-empty', 'Project still has files.', 409)
    }
    return Response.json({ ok: true })
  }

  return errorResponse('invalid-action', 'Invalid action.', 400)
}

function mapArchiveResult(result: ProjectArchiveResult): Response {
  if (result === 'not-found') {
    return errorResponse('not-found', 'Project not found.', 404)
  }
  if (result === 'forbidden') {
    return errorResponse('forbidden', 'Not allowed.', 403)
  }
  return Response.json({ ok: true })
}

function mapUnarchiveResult(result: ProjectUnarchiveResult): Response {
  if (typeof result === 'object') {
    return errorResponse(
      'project-limit-reached',
      `You've reached your plan's project limit (${result.limit} projects). Upgrade your plan or archive existing projects. See /settings/billing for upgrade options.`,
      403,
    )
  }
  return mapArchiveResult(result)
}
