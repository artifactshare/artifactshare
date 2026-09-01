import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  countReceivedAccessRequests,
  listReceivedAccessRequests,
  listSentAccessRequests,
} from '~/services/access-requests.server'
import type { Route } from './+types/api.access-requests'

export const middleware = [requireUserApiMiddleware]

export async function loader({ context, url }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const requestedId = url.searchParams.get('request')
  const [received, sent, receivedPendingCount] = await Promise.all([
    listReceivedAccessRequests(db, user, requestedId),
    listSentAccessRequests(db, user.id),
    countReceivedAccessRequests(db, user),
  ])
  return Response.json({ received, sent, receivedPendingCount })
}

export function action() {
  return new Response('Method Not Allowed', { status: 405 })
}
