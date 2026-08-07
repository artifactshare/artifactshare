import { errorResponse } from '~/lib/api-errors'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { lookupGrantUsers } from '~/services/shareables.server'
import type { Route } from './+types/api.shareables.$id.grants.lookup'

export const middleware = [requireUserApiMiddleware]

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const body = (await request.json().catch(() => null)) as {
    emails?: unknown
  } | null
  const emails = parseEmails(body)
  if (!emails) {
    return errorResponse('invalid-lookup-body', 'Invalid lookup body.', 400)
  }

  const user = requireUser(context)
  const result = await lookupGrantUsers(createDb(), user, params.id, emails)
  if (result.kind === 'not-found') {
    return errorResponse('forbidden', 'Forbidden.', 403)
  }
  return Response.json({ entries: result.entries })
}

// SQLite の bound parameter 上限 (~999) を踏まえて余裕を持って 100 件に絞る。
// UI 側の chip 入力で 1 回に渡る件数は数件〜十数件想定なので運用上問題なし。
const LOOKUP_EMAIL_LIMIT = 100

function parseEmails(body: { emails?: unknown } | null): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!Array.isArray(body.emails)) return null
  if (body.emails.length > LOOKUP_EMAIL_LIMIT) return null
  if (body.emails.some((email) => typeof email !== 'string')) return null
  return body.emails
}
