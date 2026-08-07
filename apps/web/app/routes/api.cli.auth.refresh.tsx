import { errorResponse } from '~/lib/api-errors'
import { refreshCliSession } from '~/services/cli-refresh-credentials.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.auth.refresh'

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const payload = parsePayload(await request.json().catch(() => null))
  if (!payload) {
    return errorResponse('invalid-request', 'Invalid request payload.', 400)
  }

  return await withDb(async (db) => {
    const result = await refreshCliSession(db, payload.refreshToken)
    if (result.kind !== 'ok') {
      return errorResponse(
        'unauthorized',
        'Refresh credential is invalid.',
        401,
      )
    }
    return Response.json({
      access_token: result.sessionToken,
      token_type: 'Bearer',
      expires_at: result.expiresAt,
    })
  })
}

function parsePayload(value: unknown): { refreshToken: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  return typeof raw.refresh_token === 'string' && raw.refresh_token
    ? { refreshToken: raw.refresh_token }
    : null
}
