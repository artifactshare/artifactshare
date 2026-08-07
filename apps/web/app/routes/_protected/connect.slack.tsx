import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  upsertSlackUserLink,
  verifySlackLinkState,
} from '~/services/slack.server'
import type { Route } from './+types/connect.slack'

export async function loader({
  request,
  context,
}: Route.LoaderArgs): Promise<Response> {
  const user = requireUser(context)
  const state = new URL(request.url).searchParams.get('state')
  if (!state) return new Response('Missing Slack state', { status: 400 })

  const payload = await verifySlackLinkState(state)
  if (!payload) return new Response('Invalid Slack state', { status: 400 })

  await upsertSlackUserLink(
    createDb(),
    payload.team_id,
    payload.slack_user_id,
    user.id,
  )

  return new Response('Connected Artifact Share to Slack.')
}
