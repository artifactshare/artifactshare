import { errorResponse } from '~/lib/api-errors'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { listShareableViewers } from '~/services/viewer-list.server'
import type { Route } from './+types/api.shareables.$id.viewers'

export const middleware = [requireUserApiMiddleware]

// Every loader response is per-viewer and must never be cached anywhere.
// (401 comes from the middleware and 405 from the action; those are not
// loader responses.)
const noStoreHeaders = { 'Cache-Control': 'private, no-store' } as const

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const url = new URL(request.url)
  const result = await listShareableViewers(db, {
    user,
    shareableId: params.id,
    cursor: url.searchParams.get('cursor'),
    limit: url.searchParams.get('limit'),
  })
  switch (result.kind) {
    case 'ok':
      return Response.json(
        {
          viewers: result.rows,
          nextCursor: result.nextCursor,
          totalViewers: result.totalViewers,
        },
        { headers: noStoreHeaders },
      )
    case 'not-found':
      return errorResponse('not-found', 'Shareable not found.', 404, {
        headers: noStoreHeaders,
      })
    case 'forbidden':
      return errorResponse('forbidden', 'Forbidden.', 403, {
        headers: noStoreHeaders,
      })
    case 'invalid-cursor':
      return errorResponse('invalid-cursor', 'Invalid cursor.', 400, {
        headers: noStoreHeaders,
      })
    case 'invalid-limit':
      return errorResponse('invalid-limit', 'Invalid limit.', 400, {
        headers: noStoreHeaders,
      })
    default: {
      const _exhaustive: never = result
      return _exhaustive
    }
  }
}

export function action() {
  return new Response('Method Not Allowed', { status: 405 })
}
