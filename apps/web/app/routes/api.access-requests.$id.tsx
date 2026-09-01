import { errorResponse } from '~/lib/api-errors'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { ctxContext, requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  countReceivedAccessRequests,
  processAccessRequest,
} from '~/services/access-requests.server'
import { sendAccessRequestResolutionNotifications } from '~/services/access-request-resolution-notifications.server'
import type { Route } from './+types/api.access-requests.$id'

export const middleware = [requireUserApiMiddleware]

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}

export async function action({
  request,
  params,
  context,
  url,
}: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const body = (await request.json().catch(() => null)) as {
    decision?: unknown
    scope?: unknown
    expectedProjectId?: unknown
  } | null
  if (!body || (body.decision !== 'approve' && body.decision !== 'reject')) {
    return errorResponse('invalid-request', 'Invalid request.', 400)
  }
  const decision =
    body.decision === 'reject'
      ? ({ kind: 'reject' } as const)
      : body.scope === 'artifact' || body.scope === 'project'
        ? ({
            kind: 'approve',
            scope: body.scope,
            expectedProjectId:
              typeof body.expectedProjectId === 'string'
                ? body.expectedProjectId
                : null,
          } as const)
        : null
  if (!decision) {
    return errorResponse('invalid-request', 'Invalid request.', 400)
  }

  const db = createDb()
  const user = requireUser(context)
  const result = await processAccessRequest(db, params.id, user, decision)
  if (result.kind === 'processed') {
    context.get(ctxContext).waitUntil(
      sendAccessRequestResolutionNotifications(db, {
        requestId: params.id,
        status: result.status,
        resolvedByUserId: user.id,
        origin: url.origin,
      }),
    )
  }
  switch (result.kind) {
    case 'processed':
    case 'already-processed': {
      const receivedPendingCount = await countReceivedAccessRequests(
        db,
        user,
      ).catch(() => null)
      return Response.json({
        ok: true,
        status: result.status,
        receivedPendingCount,
      })
    }
    case 'email-unverified':
      return errorResponse(
        'requester-email-unverified',
        'The requester must verify an email before approval.',
        409,
      )
    case 'location-changed':
      return errorResponse(
        'location-changed',
        'The file location changed. Reload this request.',
        409,
      )
    case 'too-many-grants':
      return errorResponse(
        'too-many-grants',
        'The sharing audience is full.',
        409,
      )
    case 'forbidden':
      return errorResponse('forbidden', 'Forbidden.', 403)
  }
}
