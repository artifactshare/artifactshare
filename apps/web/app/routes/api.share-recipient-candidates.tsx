import { env } from 'cloudflare:workers'
import { errorResponse } from '~/lib/api-errors'
import { normalizeGrantEmailList } from '~/lib/grant-emails'
import {
  isRecipientSuggestionQuery,
  RECIPIENT_SUGGESTION_PENDING_EMAIL_LIMIT,
  RECIPIENT_SUGGESTION_QUERY_MAX_LENGTH,
  type RecipientSuggestionContext,
} from '~/lib/recipient-suggestions'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { suggestRecipients } from '~/services/recipient-suggestions.server'
import type { Route } from './+types/api.share-recipient-candidates'

export const middleware = [requireUserApiMiddleware]

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const body = await request.json().catch(() => null)
  const parsed = parseBody(body)
  if (!parsed) {
    return errorResponse(
      'invalid-suggestion-body',
      'Invalid suggestion body.',
      400,
    )
  }

  const user = requireUser(context)
  const limited = await env.RECIPIENT_SUGGESTIONS_RATELIMIT.limit({
    key: user.id,
  }).catch(() => null)
  if (!limited) {
    return errorResponse(
      'suggestions-unavailable',
      'Recipient suggestions are temporarily unavailable.',
      503,
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
  if (!limited.success) {
    return errorResponse('rate-limited', 'Too many suggestion requests.', 429, {
      headers: { 'Cache-Control': 'private, no-store', 'Retry-After': '60' },
    })
  }
  if (!isRecipientSuggestionQuery(parsed.query)) {
    return Response.json(
      { candidates: [] },
      { headers: { 'Cache-Control': 'private, no-store' } },
    )
  }
  const result = await suggestRecipients(
    createDb(),
    user,
    parsed.context,
    parsed.query,
    parsed.pendingEmails,
  )
  if (result.kind === 'forbidden') {
    return errorResponse('forbidden', 'Forbidden.', 403, {
      headers: { 'Cache-Control': 'private, no-store' },
    })
  }
  return Response.json(
    { candidates: result.candidates },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}

function parseBody(value: unknown): {
  query: string
  pendingEmails: string[]
  context: RecipientSuggestionContext
} | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { query, pendingEmails, context } = value as Record<string, unknown>
  const parsedContext = parseContext(context)
  if (
    typeof query !== 'string' ||
    Array.from(query).length > RECIPIENT_SUGGESTION_QUERY_MAX_LENGTH ||
    !Array.isArray(pendingEmails) ||
    pendingEmails.length > RECIPIENT_SUGGESTION_PENDING_EMAIL_LIMIT ||
    pendingEmails.some((email) => typeof email !== 'string') ||
    !parsedContext
  ) {
    return null
  }
  return {
    query,
    pendingEmails: normalizeGrantEmailList(pendingEmails as string[]),
    context: parsedContext,
  }
}

function parseContext(value: unknown): RecipientSuggestionContext | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { kind, id } = value as Record<string, unknown>
  if (kind === 'upload' && id === undefined) return { kind }
  if (
    (kind === 'shareable' || kind === 'project') &&
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 100
  ) {
    return { kind, id }
  }
  return null
}
