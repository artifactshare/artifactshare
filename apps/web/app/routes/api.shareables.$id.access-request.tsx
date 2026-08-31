import { errorResponse } from '~/lib/api-errors'
import { ctxContext } from '~/middleware/context'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { createAccessRequest } from '~/services/access-requests.server'
import { sendAccessRequestNotifications } from '~/services/access-request-email.server'
import type { Route } from './+types/api.shareables.$id.access-request'

export const middleware = [requireUserApiMiddleware]

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const db = createDb()
  const result = await createAccessRequest(db, params.id, user)
  switch (result.kind) {
    case 'created':
      context.get(ctxContext).waitUntil(
        sendAccessRequestNotifications({
          requestId: result.requestId,
          requesterName: user.name,
          requesterEmail: user.email,
          shareableTitle: result.shareableTitle,
          recipientEmails: result.approverEmails,
          origin: new URL(request.url).origin,
        }),
      )
      return Response.json({ ok: true, status: 'pending', created: true })
    case 'pending':
      return Response.json({ ok: true, status: 'pending', created: false })
    case 'email-unverified':
      return errorResponse(
        'email-unverified',
        'Verify your email before requesting access.',
        403,
      )
    case 'not-found':
      return errorResponse('not-found', 'Not found.', 404)
    case 'not-denied':
      return errorResponse('access-changed', 'Access has changed.', 409)
  }
}
