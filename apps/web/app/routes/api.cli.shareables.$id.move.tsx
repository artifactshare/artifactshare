import {
  ArtifactIdParamsSchema,
  CliMoveRequestSchema,
  CliMoveResponseSchema,
} from '@artifactshare/contract'
import { errorResponse } from '~/lib/api-errors'
import {
  cliMoveErrorResponse,
  cliMoveSuccessBody,
} from '~/lib/shareable-settings-adapter.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { withDb } from '~/services/db.server'
import { moveShareableContainer } from '~/services/shareables.server'
import type { Route } from './+types/api.cli.shareables.$id.move'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }
  const body = await request.json().catch(() => null)
  const parsedBody = CliMoveRequestSchema.safeParse(body)
  if (!parsedBody.success) {
    return errorResponse('invalid-destination', 'Invalid destination.', 400)
  }
  const destination =
    parsedBody.data.destination === 'home'
      ? { type: 'inbox' as const }
      : {
          type: 'project' as const,
          projectId: parsedBody.data.destination.project_id,
        }

  const result = await withDb(
    async (db) =>
      await moveShareableContainer(
        db,
        user,
        parsedParams.data.id,
        destination,
        getCliAuthority(context),
      ),
  )
  if (result.kind !== 'ok') {
    return cliMoveErrorResponse(result)
  }
  return Response.json(
    CliMoveResponseSchema.parse(
      cliMoveSuccessBody({
        requestUrl: request.url,
        shareableId: parsedParams.data.id,
        destination,
        result,
      }),
    ),
  )
}
