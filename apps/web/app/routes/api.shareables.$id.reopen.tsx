import { errorResponse } from '~/lib/api-errors'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { reopenExpiredLink } from '~/services/link-sharing.server'
import type { Route } from './+types/api.shareables.$id.reopen'

export const middleware = [requireUserApiMiddleware]

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const user = requireUser(context)
  const result = await reopenExpiredLink(createDb(), user, params.id)
  switch (result.kind) {
    case 'ok':
      return Response.json({ link_expires_at: result.linkExpiresAt })
    case 'not-found':
      return errorResponse('not-found', 'Shareable not found.', 404)
    case 'forbidden':
      return errorResponse('forbidden', 'Forbidden.', 403)
    case 'plan-required':
      return errorResponse(
        'link-sharing-plan-required',
        'Link sharing requires a Plus or Team plan.',
        402,
      )
    case 'disabled':
      return errorResponse(
        'link-sharing-disabled',
        'Link sharing is disabled for this workspace.',
        403,
      )
    case 'invalid-policy':
      return errorResponse(
        'link-expiry-invalid',
        'The link expiry is invalid for this workspace policy.',
        400,
      )
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}
