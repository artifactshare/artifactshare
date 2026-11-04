import {
  ArtifactIdParamsSchema,
  ArtifactVersionsResponseSchema,
} from '@artifactshare/contract'
import { cliReadAuthority } from '~/lib/cli-authority-policy'
import { cliScopeDeniedResponse } from '~/lib/cli-agent-operations'
import { errorResponse } from '~/lib/api-errors'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { authorizeAgentArtifactRead } from '~/services/agent-scope.server'
import { getArtifactVersions } from '~/services/artifact-versions.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.artifacts.$id.versions'

export const middleware = [requireUserApiWithBearerMiddleware]
export async function loader({ context, params, url }: Route.LoaderArgs) {
  const user = requireUser(context)
  const authority = cliReadAuthority(getCliAuthority(context))
  if (authority === 'denied') return cliScopeDeniedResponse()
  const parsed = ArtifactIdParamsSchema.safeParse(params)
  if (!parsed.success)
    return errorResponse('not-found', 'Artifact not found.', 404)
  return await withDb(async (db) => {
    const agentRead =
      authority !== null
        ? await authorizeAgentArtifactRead(db, user, authority, parsed.data.id)
        : null
    if (agentRead?.kind === 'missing-viewer')
      return new Response('Unauthorized', { status: 401 })
    if (agentRead?.kind === 'denied')
      return errorResponse('not-found', 'Artifact not found.', 404)
    const result = await getArtifactVersions(db, user, {
      id: parsed.data.id,
      ...(url.searchParams.has('cursor')
        ? { cursor: url.searchParams.get('cursor')! }
        : {}),
      ...(agentRead?.kind === 'authorized'
        ? { agentReadAuthorization: agentRead.authorization }
        : {}),
    })
    if (result.kind === 'ok')
      return Response.json(ArtifactVersionsResponseSchema.parse(result.data))
    if (result.kind === 'invalid-cursor')
      return errorResponse(
        'validation-failed',
        'Invalid versions cursor. Restart without --cursor.',
        400,
      )
    return errorResponse('not-found', 'Artifact not found.', 404)
  })
}
