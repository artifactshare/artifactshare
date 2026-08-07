import { env } from 'cloudflare:workers'
import { redirect } from 'react-router'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  signSlackInstallState,
  slackOauthCallbackUrl,
} from '~/services/slack.server'
import { requireWorkspaceAdmin } from '~/services/team-management.server'
import type { Route } from './+types/integrations.slack.install'

const SLACK_BOT_SCOPES = [
  'links:read',
  'links:write',
  'users:read',
  'users:read.email',
].join(',')

export async function loader({ request, context }: Route.LoaderArgs) {
  if (!env.SLACK_CLIENT_ID) {
    return new Response('Missing SLACK_CLIENT_ID', { status: 500 })
  }
  const user = requireUser(context)
  const adminCheck = await requireWorkspaceAdmin(createDb(), user)
  if (adminCheck.kind !== 'ok') {
    return redirect(`/settings/integrations?status=${adminCheck.kind}`)
  }

  const state = await signSlackInstallState({
    admin_user_id: user.id,
    workspace_id: user.workspaceId,
  })
  const redirectUri = slackOauthCallbackUrl(request.url)

  const slackUrl = new URL('https://slack.com/oauth/v2/authorize')
  slackUrl.searchParams.set('client_id', env.SLACK_CLIENT_ID)
  slackUrl.searchParams.set('scope', SLACK_BOT_SCOPES)
  slackUrl.searchParams.set('redirect_uri', redirectUri)
  slackUrl.searchParams.set('state', state)
  return redirect(slackUrl.toString())
}
