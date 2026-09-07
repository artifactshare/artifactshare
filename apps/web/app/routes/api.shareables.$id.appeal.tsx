import { errorResponse } from '~/lib/api-errors'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  LINK_APPEAL_MESSAGE_MAX,
  appealLinkSuspension,
} from '~/services/link-suspension.server'
import type { Route } from './+types/api.shareables.$id.appeal'

export const middleware = [requireUserApiMiddleware]

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const body = (await request.json().catch(() => null)) as {
    message?: unknown
  } | null
  const message =
    body && typeof body.message === 'string' ? body.message.trim() : ''
  if (!message || message.length > LINK_APPEAL_MESSAGE_MAX) {
    return errorResponse('invalid-appeal', 'Write a short message.', 400)
  }
  const result = await appealLinkSuspension(createDb(), user, {
    shareableId: params.id,
    message,
  })
  switch (result.kind) {
    case 'appealed':
      return Response.json({ ok: true })
    case 'not-found':
      return errorResponse('not-found', 'Shareable not found.', 404)
    case 'forbidden':
      return errorResponse('forbidden', 'Forbidden.', 403)
    case 'not-suspended':
      return errorResponse('not-suspended', 'This link is not paused.', 409)
    case 'cooldown':
      return errorResponse(
        'appeal-cooldown',
        'An appeal was sent recently; wait before sending another.',
        429,
      )
  }
}
