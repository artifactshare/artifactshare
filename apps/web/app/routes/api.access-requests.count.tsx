import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { countReceivedAccessRequests } from '~/services/access-requests.server'
import type { Route } from './+types/api.access-requests.count'

export const middleware = [requireUserApiMiddleware]

export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  return Response.json({ count: await countReceivedAccessRequests(db, user) })
}

export function action() {
  return new Response('Method Not Allowed', { status: 405 })
}
