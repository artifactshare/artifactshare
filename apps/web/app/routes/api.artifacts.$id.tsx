import { errorResponse } from '~/lib/api-errors'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { deleteShareable } from '~/services/shareables.server'
import type { Route } from './+types/api.artifacts.$id'

export const middleware = [requireUserApiMiddleware]

export function action({ request, params, context }: Route.ActionArgs) {
  if (request.method === 'DELETE') return deleteAction(params, context)
  return new Response('Method Not Allowed', { status: 405 })
}

async function deleteAction(
  params: Route.ActionArgs['params'],
  context: Route.ActionArgs['context'],
) {
  const user = requireUser(context)
  const result = await deleteShareable(createDb(), user, params.id, {
    allowManagerDelete: true,
  })
  switch (result.kind) {
    case 'ok':
      return new Response(null, { status: 204 })
    case 'not-found':
      return new Response('Not found', { status: 404 })
    case 'delete-failed':
      return errorResponse('delete-failed', 'Failed to delete file.', 502)
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}
