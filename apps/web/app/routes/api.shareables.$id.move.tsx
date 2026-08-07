import { errorResponse } from '~/lib/api-errors'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  listMoveDestinations,
  moveShareableContainer,
  type MoveDestination,
} from '~/services/shareables.server'
import type { Route } from './+types/api.shareables.$id.move'

export const middleware = [requireUserApiMiddleware]

export async function loader({ params, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const result = await listMoveDestinations(createDb(), user, params.id)
  if (result.kind === 'not-found') {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }
  return Response.json(result)
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const body = (await request.json().catch(() => null)) as {
    destination?: unknown
  } | null
  const destination = parseDestination(body?.destination)
  if (!destination) {
    return errorResponse('invalid-destination', 'Invalid destination.', 400)
  }

  const result = await moveShareableContainer(
    createDb(),
    user,
    params.id,
    destination,
  )
  if (result.kind === 'not-found') {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }
  if (result.kind === 'invalid-destination') {
    return errorResponse('invalid-destination', 'Invalid destination.', 400)
  }
  return Response.json({
    kind: 'ok',
    containerId: result.containerId,
    containerName: result.containerName,
  })
}

// 'inbox' moves to the owner's 未整理; any other non-empty string is a target
// project container id, validated server-side.
function parseDestination(value: unknown): MoveDestination | null {
  if (value === 'inbox') return { type: 'inbox' }
  if (typeof value === 'string' && value.length > 0) {
    return { type: 'project', projectId: value }
  }
  return null
}
