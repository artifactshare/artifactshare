import { bridgeErrorResponse } from '~/lib/bridge-api.server'
import { requireBridgeBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority } from '~/middleware/context'
import { readLiveBridgeAuthority } from '~/services/bridge-authorities.server'
import { createDb } from '~/services/db.server'
import type { Route } from './+types/api.bridge.v1.health'

export const middleware = [requireBridgeBearerMiddleware]

export async function loader({ context }: Route.LoaderArgs) {
  const authority = getCliAuthority(context)
  if (authority?.kind !== 'bridge') {
    return bridgeErrorResponse(
      'unsupported-authority',
      'This credential is not a bridge authority.',
      403,
    )
  }
  const live = await readLiveBridgeAuthority(
    createDb(),
    authority.bridgeAuthorityId,
  )
  if (live.kind === 'unsupported-authority') {
    return bridgeErrorResponse(
      'unsupported-authority',
      'The bridge authority is unavailable.',
      403,
    )
  }
  if (live.kind === 'fallback-invalid') {
    return bridgeErrorResponse(
      'fallback-invalid',
      'The bridge fallback project is unavailable.',
      409,
    )
  }
  return Response.json({
    schema_version: 1,
    ok: true,
    data: {
      authority: 'available',
      operations: ['publish', 'append', 'update', 'set_visibility'],
    },
  })
}
