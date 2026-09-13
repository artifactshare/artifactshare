import { errorResponse } from '~/lib/api-errors'
import {
  CliAuthRefreshCredentialsRequestSchema,
  CliAuthRefreshCredentialsResponseSchema,
} from '@artifactshare/contract'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import {
  getSessionUserFromBearer,
  readBearerSessionToken,
} from '~/services/auth.server'
import { isApiToken } from '~/services/api-tokens.server'
import {
  isCliRefreshedSessionToken,
  issueCliRefreshCredential,
} from '~/services/cli-refresh-credentials.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.auth.refresh-credentials'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const bearerToken = readBearerSessionToken(request)
  if (!bearerToken) {
    return errorResponse(
      'unauthorized',
      'CLI session bearer token is required.',
      401,
    )
  }
  if (isApiToken(bearerToken)) {
    return errorResponse(
      'forbidden',
      'API tokens cannot issue CLI refresh credentials.',
      403,
    )
  }
  if (isCliRefreshedSessionToken(bearerToken)) {
    return errorResponse(
      'forbidden',
      'Refreshed CLI sessions cannot issue CLI refresh credentials.',
      403,
    )
  }
  const bearerUser = await getSessionUserFromBearer(request)
  if (!bearerUser) {
    return errorResponse(
      'unauthorized',
      'CLI session bearer token is invalid.',
      401,
    )
  }
  // Older clients sent no body. Keep malformed metadata non-fatal while the
  // shared schema still defines and validates every accepted metadata field.
  const payload = CliAuthRefreshCredentialsRequestSchema.safeParse(
    await request.json().catch(() => null),
  )
  const deviceName = payload.success
    ? payload.data.device_name?.trim() || null
    : null
  const deviceId = payload.success
    ? payload.data.device_id?.trim() || null
    : null

  return await withDb(async (db) => {
    const credential = await issueCliRefreshCredential(
      db,
      bearerUser.id,
      bearerToken,
      deviceName,
      deviceId,
    )
    if (!credential) {
      return errorResponse(
        'forbidden',
        'Only a device-login session can issue CLI refresh credentials.',
        403,
      )
    }
    return Response.json(
      CliAuthRefreshCredentialsResponseSchema.parse({
        refresh_token: credential.refreshToken,
        refresh_token_expires_at: credential.expiresAt,
      }),
    )
  })
}
