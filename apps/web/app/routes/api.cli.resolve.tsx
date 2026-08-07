import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { withDb } from '~/services/db.server'
import { resolveCliCandidates } from '~/services/cli-resolve.server'
import type { Route } from './+types/api.cli.resolve'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context, request }: Route.LoaderArgs) {
  const user = requireUser(context)
  const url = new URL(request.url)
  const query = url.searchParams.get('q')?.trim() ?? ''
  if (!query) {
    return Response.json(
      { error: { code: 'invalid-query', message: 'Query is required.' } },
      { status: 400 },
    )
  }

  return await withDb(async (db) =>
    Response.json(await resolveCliCandidates(db, user, query)),
  )
}
