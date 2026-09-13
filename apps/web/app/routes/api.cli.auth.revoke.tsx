import { errorResponse } from '~/lib/api-errors'
import {
  CliAuthRevokeRequestSchema,
  CliAuthRevokeResponseSchema,
} from '@artifactshare/contract'
import { revokeCliRefreshCredential } from '~/services/cli-refresh-credentials.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.auth.revoke'

export async function action({ request }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const payload = CliAuthRevokeRequestSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!payload.success) {
    return errorResponse('invalid-request', 'Invalid request payload.', 400)
  }
  return await withDb(async (db) => {
    const result = await revokeCliRefreshCredential(
      db,
      payload.data.refresh_token,
    )
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
    return Response.json(CliAuthRevokeResponseSchema.parse({ revoked: true }))
  })
}
