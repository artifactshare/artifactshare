import { errorResponse } from '~/lib/api-errors'
import { MAX_EMAILS_PER_REQUEST } from '~/lib/grant-emails'
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

function parseEmails(body: { emails?: unknown } | null): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  if (!Array.isArray(body.emails)) return null
  if (body.emails.length > MAX_EMAILS_PER_REQUEST) return null
  if (body.emails.some((email) => typeof email !== 'string')) return null
  return body.emails
}
