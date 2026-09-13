import { DownloadFileParamsSchema } from '@artifactshare/contract'
import { cliArtifactErrorResponse, errorResponse } from '~/lib/api-errors'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { isAgentReadableArtifact } from '~/services/agent-scope.server'
import { getCliDownloadFile } from '~/services/cli-download.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.artifacts.$id.download.$'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, params }: Route.LoaderArgs) {
  const user = requireUser(context)
  const parsedParams = DownloadFileParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Artifact not found.', 404)
  }
  const { id, '*': path } = parsedParams.data
  const filePath = `/${path}`
  return await withDb(async (db) => {
    const authority = getCliAuthority(context)
    if (
      authority?.kind === 'agent' &&
      !(await isAgentReadableArtifact(db, user, authority, id))
    ) {
      return new Response('Not Found', { status: 404 })
    }
    const result = await getCliDownloadFile(db, user, {
      id,
      path: filePath,
    })
    if (result.kind === 'ok') {
      if (!result.object.body) {
        return errorResponse(
          'source-unavailable',
          'Artifact source is unavailable.',
          409,
        )
      }
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
    return cliArtifactErrorResponse(
      result,
      'This artifact kind cannot be downloaded yet.',
    )
  })
}
