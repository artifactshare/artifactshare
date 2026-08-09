import { errorResponse } from '~/lib/api-errors'
import { env } from 'cloudflare:workers'
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
    const result = await refreshCliSession(
      db,
      payload.refreshToken,
      payload.rotationRequestId,
      env.BETTER_AUTH_SECRET,
    )
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
      expires_at: result.sessionExpiresAt,
      refresh_token: result.refreshToken,
      refresh_token_expires_at: result.refreshExpiresAt,
    })
  })
}

function parsePayload(
  value: unknown,
): { refreshToken: string; rotationRequestId: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  if (
    typeof raw.refresh_token !== 'string' ||
    raw.refresh_token.length === 0 ||
    raw.refresh_token.length > 256
  ) {
    return null
  }
  if (raw.rotation_request_id === undefined) {
    // Released CLIs before credential rotation omit this field. Keep their
    // non-rotating refresh path available while the rotating CLI rolls out.
    return { refreshToken: raw.refresh_token, rotationRequestId: null }
  }
  return typeof raw.rotation_request_id === 'string' &&
    raw.rotation_request_id.length > 0 &&
    raw.rotation_request_id.length <= 128
    ? {
        refreshToken: raw.refresh_token,
        rotationRequestId: raw.rotation_request_id,
      }
    : null
}
