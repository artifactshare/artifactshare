import { cliScopeDeniedResponse } from '~/lib/cli-agent-operations'
import { cliReadAuthority } from '~/lib/cli-authority-policy'
import {
  ArtifactIdParamsSchema,
  DownloadManifestResponseSchema,
} from '@artifactshare/contract'
import { cliArtifactErrorResponse } from '~/lib/api-errors'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { authorizeAgentArtifactRead } from '~/services/agent-scope.server'
import {
  getCliDownloadManifest,
  getPublisherDownloadFile,
} from '~/services/cli-download.server'
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
    const resolved = getCliAuthority(context)
    if (resolved?.kind === 'publisher') {
      const result = await getPublisherDownloadFile(db, user, resolved, id)
      if (result.kind !== 'ok')
        return cliArtifactErrorResponse(
          result,
          'This artifact kind cannot be downloaded yet.',
        )
      if (!result.object.body)
        return new Response('Source unavailable', { status: 409 })
      return new Response(result.object.body, {
        headers: {
          'content-type': result.file.content_type,
          'content-length': String(result.object.size),
          'content-disposition': 'attachment',
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
          'content-security-policy':
            "default-src 'none'; frame-ancestors 'none'; form-action 'none'",
        },
      })
    }
    const authority = cliReadAuthority(resolved)
    if (authority === 'denied') return cliScopeDeniedResponse()
    const agentRead =
      authority !== null
        ? await authorizeAgentArtifactRead(db, user, authority, id)
        : null
    if (agentRead?.kind === 'missing-viewer') {
      return new Response('Unauthorized', { status: 401 })
    }
    if (agentRead?.kind === 'denied') {
      return new Response('Not Found', { status: 404 })
    }
    const result = await getCliDownloadManifest(db, user, {
      id,
      baseUrl: new URL(request.url).origin,
      ...(agentRead?.kind === 'authorized'
        ? { agentReadAuthorization: agentRead.authorization }
        : {}),
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
