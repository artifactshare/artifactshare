import { cliArtifactErrorResponse, errorResponse } from '~/lib/api-errors'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { getCliDownloadFile } from '~/services/cli-download.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.artifacts.$id.download.$'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, params }: Route.LoaderArgs) {
  const user = requireUser(context)
  const filePath = `/${params['*'] ?? ''}`
  return await withDb(async (db) => {
    const result = await getCliDownloadFile(db, user, {
      id: params.id,
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
