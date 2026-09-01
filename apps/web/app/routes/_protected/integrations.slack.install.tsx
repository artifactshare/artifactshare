import { env } from 'cloudflare:workers'
import { redirect } from 'react-router'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  getWorkspaceSlackConnection,
  signSlackInstallState,
  SLACK_INSTALL_BOT_SCOPES,
  slackOauthCallbackUrl,
} from '~/services/slack.server'
import { requireWorkspaceAdmin } from '~/services/team-management.server'
import type { Route } from './+types/integrations.slack.install'

export async function loader({ request, context }: Route.LoaderArgs) {
  if (!env.SLACK_CLIENT_ID) {
    return new Response('Missing SLACK_CLIENT_ID', { status: 500 })
  }
  const user = requireUser(context)
  const db = createDb()
  const adminCheck = await requireWorkspaceAdmin(db, user)
  if (adminCheck.kind !== 'ok') {
    return redirect(`/settings/integrations?status=${adminCheck.kind}`)
  }

  const connectionId = new URL(request.url).searchParams.get('connection')
  const connection = connectionId
    ? await getWorkspaceSlackConnection(db, user.workspaceId, connectionId)
    : null
  if (connectionId && !connection) {
    return redirect('/settings/integrations?status=not-found')
  }

  const state = await signSlackInstallState({
    admin_user_id: user.id,
    workspace_id: user.workspaceId,
    ...(connection
      ? {
          connection_id: connection.id,
          expected_team_id: connection.teamId,
        }
      : {}),
  })
  const redirectUri = slackOauthCallbackUrl(request.url)

  const slackUrl = new URL('https://slack.com/oauth/v2/authorize')
  slackUrl.searchParams.set('client_id', env.SLACK_CLIENT_ID)
  slackUrl.searchParams.set('scope', SLACK_INSTALL_BOT_SCOPES.join(','))
  slackUrl.searchParams.set('redirect_uri', redirectUri)
  slackUrl.searchParams.set('state', state)
  if (connection) slackUrl.searchParams.set('team', connection.teamId)
  return redirect(slackUrl.toString())
}
