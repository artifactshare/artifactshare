import { searchNoStoreMiddleware } from '~/services/search-response.server'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { withDb } from '~/services/db.server'
import { readSearchLogs } from '~/services/search-logs.server'
import type { Route } from './+types/api.search-logs'
export const middleware = [searchNoStoreMiddleware, requireUserApiMiddleware]
export async function loader({ context }: Route.LoaderArgs) {
  const actor = requireUser(context)
  return Response.json(
    { searches: await withDb((db) => readSearchLogs(db, actor.id)) },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
