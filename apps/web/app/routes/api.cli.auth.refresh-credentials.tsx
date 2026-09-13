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
  // Preserve legacy per-field normalization: malformed metadata must not
  // discard a valid sibling field, especially the ID used for superseding.
  const payload = await request.json().catch(() => null)
  const readMetadata = (field: 'device_name' | 'device_id') => {
    const value =
      payload && typeof payload === 'object' && field in payload
        ? (payload as Record<string, unknown>)[field]
        : undefined
    const parsed = CliAuthRefreshCredentialsRequestSchema.shape[
      field
    ].safeParse(typeof value === 'string' ? value.trim().slice(0, 100) : value)
    return parsed.success ? parsed.data || null : null
  }
  const deviceName = readMetadata('device_name')
  const deviceId = readMetadata('device_id')

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
