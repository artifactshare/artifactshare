import { env } from 'cloudflare:workers'
import { redirect } from 'react-router'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { findWorkspaceProject } from '~/services/projects.server'
import {
  signSlackNotifyState,
  slackNotifyOauthCallbackUrl,
} from '~/services/slack.server'
import type { Route } from './+types/projects.$id.slack.install'

export async function loader({ request, params, context }: Route.LoaderArgs) {
  if (!env.SLACK_CLIENT_ID)
    return new Response('Missing SLACK_CLIENT_ID', { status: 500 })
  const user = requireUser(context)
  const id = params.id
  if (
    !id ||
    !(await findWorkspaceProject(createDb(), user.workspaceId, id, user))
  ) {
    throw new Response('Not found', { status: 404 })
  }
  const state = await signSlackNotifyState({
    user_id: user.id,
    workspace_id: user.workspaceId,
    container_id: id,
  })
  const url = new URL('https://slack.com/oauth/v2/authorize')
  url.searchParams.set('client_id', env.SLACK_CLIENT_ID)
  url.searchParams.set('scope', 'incoming-webhook')
  url.searchParams.set('state', state)
  url.searchParams.set('redirect_uri', slackNotifyOauthCallbackUrl(request.url))
  return redirect(url.toString())
}
