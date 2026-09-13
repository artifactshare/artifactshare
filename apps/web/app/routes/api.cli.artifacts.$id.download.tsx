import {
  ArtifactIdParamsSchema,
  DownloadManifestResponseSchema,
} from '@artifactshare/contract'
import { cliArtifactErrorResponse } from '~/lib/api-errors'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { isAgentReadableArtifact } from '~/services/agent-scope.server'
import { getCliDownloadManifest } from '~/services/cli-download.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.artifacts.$id.download'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return new Response('Not Found', { status: 404 })
  }
  const { id } = parsedParams.data
  return await withDb(async (db) => {
    const authority = getCliAuthority(context)
    if (
      authority?.kind === 'agent' &&
      !(await isAgentReadableArtifact(db, user, authority, id))
    ) {
      return new Response('Not Found', { status: 404 })
    }
    const result = await getCliDownloadManifest(db, user, {
      id,
      baseUrl: new URL(request.url).origin,
    })
    if (result.kind === 'ok') {
      return Response.json(DownloadManifestResponseSchema.parse(result.data))
    }
    return cliArtifactErrorResponse(
      result,
      'This artifact kind cannot be downloaded yet.',
    )
  })
}
