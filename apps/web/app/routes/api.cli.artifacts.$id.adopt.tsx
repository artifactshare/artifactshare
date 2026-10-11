import {
  ArtifactIdParamsSchema,
  PublisherAdoptRequestSchema,
  PublisherAdoptResponseSchema,
} from '@artifactshare/contract'
import { errorResponse } from '~/lib/api-errors'
import { cliScopeDeniedResponse } from '~/lib/cli-agent-operations'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import {
  authSourceContext,
  getCliAuthority,
  requireUser,
} from '~/middleware/context'
import { withDb } from '~/services/db.server'
import { adoptPublisherArtifact } from '~/services/publisher-adoption.server'
import type { Route } from './+types/api.cli.artifacts.$id.adopt'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST')
    return new Response('Method Not Allowed', { status: 405 })
  const user = requireUser(context)
  const authority = getCliAuthority(context)
  const browser = context.get(authSourceContext) === 'cookie'
  if (authority ? authority.kind !== 'unrestricted' : !browser)
    return cliScopeDeniedResponse()
  const parsedId = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedId.success)
    return errorResponse('not-found', 'Artifact not found.', 404)
  const body = PublisherAdoptRequestSchema.safeParse(
    await request.json().catch(() => null),
  )
  if (!body.success)
    return errorResponse('validation-failed', 'Invalid adoption payload.', 400)
  const result = await withDb((db) =>
    adoptPublisherArtifact(
      db,
      user,
      authority,
      browser,
      parsedId.data.id,
      body.data.publisher_client_id,
    ),
  )
  if (result.kind === 'scope-denied') return cliScopeDeniedResponse()
  if (result.kind === 'not-found')
    return errorResponse(
      'not-found',
      'Artifact or publisher client not found.',
      404,
    )
  if (result.kind === 'conflict')
    return errorResponse(
      'conflict',
      'Publisher assignment changed. Try again.',
      409,
    )
  return Response.json(
    PublisherAdoptResponseSchema.parse({
      id: parsedId.data.id,
      publisher_client_id: body.data.publisher_client_id,
    }),
  )
}
