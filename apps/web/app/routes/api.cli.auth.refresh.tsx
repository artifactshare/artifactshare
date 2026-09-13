import { errorResponse } from '~/lib/api-errors'
import {
  CliAuthRefreshRequestSchema,
  CliAuthRefreshResponseSchema,
} from '@artifactshare/contract'
import { env } from 'cloudflare:workers'
import { refreshCliSession } from '~/services/cli-refresh-credentials.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.auth.refresh'

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const payload = CliAuthRefreshRequestSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!payload.success) {
    return errorResponse('invalid-request', 'Invalid request payload.', 400)
  }

  return await withDb(async (db) => {
    const result = await refreshCliSession(
      db,
      payload.data.refresh_token,
      payload.data.rotation_request_id ?? null,
      env.BETTER_AUTH_SECRET,
    )
    if (result.kind !== 'ok') {
      return errorResponse(
        'unauthorized',
        'Refresh credential is invalid.',
        401,
      )
    }
    return Response.json(
      CliAuthRefreshResponseSchema.parse({
        access_token: result.sessionToken,
        token_type: 'Bearer',
        expires_at: result.sessionExpiresAt,
        refresh_token: result.refreshToken,
        refresh_token_expires_at: result.refreshExpiresAt,
      }),
    )
  })
}
