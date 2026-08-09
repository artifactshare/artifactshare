import { errorResponse } from '~/lib/api-errors'
import { revokeCliRefreshCredential } from '~/services/cli-refresh-credentials.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.auth.revoke'

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const payload = parsePayload(await request.json().catch(() => null))
  if (!payload) {
    return errorResponse('invalid-request', 'Invalid request payload.', 400)
  }
  return await withDb(async (db) => {
    const result = await revokeCliRefreshCredential(db, payload.refreshToken)
    if (result === 'invalid') {
      return errorResponse(
        'unauthorized',
        'Refresh credential is invalid.',
        401,
      )
    }
    if (result === 'inconsistent') {
      return errorResponse(
        'service-error',
        'Refresh credential could not be safely revoked.',
        503,
      )
    }
    return Response.json({ revoked: true })
  })
}

function parsePayload(value: unknown): { refreshToken: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  return typeof raw.refresh_token === 'string' &&
    raw.refresh_token.length > 0 &&
    raw.refresh_token.length <= 256
    ? { refreshToken: raw.refresh_token }
    : null
}
