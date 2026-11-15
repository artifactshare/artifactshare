import { searchNoStoreMiddleware } from '~/services/search-response.server'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { isSameOriginRequest } from '~/lib/same-origin-request'
import { withDb } from '~/services/db.server'
import { recordSearchOpen } from '~/services/search-logs.server'
import type { Route } from './+types/api.search-logs.$id.opens'
export const middleware = [searchNoStoreMiddleware, requireUserApiMiddleware]
export async function action({ request, params, context }: Route.ActionArgs) {
  const actor = requireUser(context)
  const headers = { 'Cache-Control': 'private, no-store' }
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers })
  if (!isSameOriginRequest(request))
    return new Response(null, { status: 403, headers })
  const body: unknown = await request.json().catch(() => null)
  if (
    !body ||
    typeof body !== 'object' ||
    !('receipt' in body) ||
    typeof body.receipt !== 'string' ||
    body.receipt.length > 1024
  )
    return Response.json(
      { error: { code: 'validation_error', fields: ['receipt'] } },
      { status: 400, headers },
    )
  const receipt = body.receipt
  const found = await withDb((db) =>
    recordSearchOpen(db, actor.id, params.id, receipt),
  )
  return new Response(null, { status: found ? 204 : 404, headers })
}
