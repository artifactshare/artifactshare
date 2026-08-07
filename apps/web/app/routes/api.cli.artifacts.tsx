import { errorResponse } from '~/lib/api-errors'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { listCliArtifacts } from '~/services/cli-artifacts.server'
import { withDb } from '~/services/db.server'
import type { Route } from './+types/api.cli.artifacts'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const url = new URL(request.url)
  const projectId = url.searchParams.get('project_id') ?? undefined
  const query = url.searchParams.get('query')?.trim() || undefined
  const cursor = url.searchParams.get('cursor') ?? undefined

  return await withDb(async (db) => {
    const result = await listCliArtifacts(db, user, {
      baseUrl: url.origin,
      projectId,
      query,
      cursor,
    })
    switch (result.kind) {
      case 'ok':
        return Response.json(result.data)
      case 'invalid-project':
        return errorResponse(
          'invalid-destination',
          'The project ID does not exist or is not available in this workspace.',
          400,
        )
      case 'invalid-cursor':
        return errorResponse(
          'validation_failed',
          'The cursor is invalid or does not match the requested filters.',
          400,
        )
      default: {
        const _exhaustive: never = result
        return _exhaustive
      }
    }
  })
}
