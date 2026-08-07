import { errorResponse } from '~/lib/api-errors'
import {
  cliMoveErrorResponse,
  cliMoveSuccessBody,
  parseCliDestination,
} from '~/lib/shareable-settings-adapter.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { withDb } from '~/services/db.server'
import { moveShareableContainer } from '~/services/shareables.server'
import type { Route } from './+types/api.cli.shareables.$id.move'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const body = (await request.json().catch(() => null)) as {
    destination?: unknown
  } | null
  const destination = parseCliDestination(body?.destination)
  if (!destination) {
    return errorResponse('invalid-destination', 'Invalid destination.', 400)
  }

  const result = await withDb(
    async (db) =>
      await moveShareableContainer(db, user, params.id, destination),
  )
  if (result.kind !== 'ok') {
    return cliMoveErrorResponse(result)
  }
  return Response.json(
    cliMoveSuccessBody({
      requestUrl: request.url,
      shareableId: params.id,
      destination,
      result,
    }),
  )
}
